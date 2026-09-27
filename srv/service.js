/**
 * service.js — ES Module version
 *
 * SAP CAP Service Implementation — HackfestService
 */

import cds     from '@sap/cds';
import * as engine  from './supplyChainEngine.js';
import * as agents  from './agentOrchestrator.js';
import * as gemini  from './geminiModel.js';

const log = {
  info:  (msg, ...a) => console.log(`[Service][INFO]  ${msg}`, ...a),
  warn:  (msg, ...a) => console.warn(`[Service][WARN]  ${msg}`, ...a),
  error: (msg, ...a) => console.error(`[Service][ERROR] ${msg}`, ...a)
};

function newUUID() { return cds.utils.uuid(); }
function now()     { return new Date().toISOString(); }

function ok(data)  { return JSON.stringify({ success: true,  data   }); }
function fail(msg) { return JSON.stringify({ success: false, error: msg }); }

async function createAudit(_, { disruptionId, action, actor = 'System', details = '', event, entity, entityId, previousStatus, newStatus, severity = 'Info' }) {
  try {
    await cds.db.run(cds.ql.INSERT.into('hackfest.db.AuditLogs').entries({
      ID: newUUID(), disruption_ID: disruptionId, action, actor, details,
      timestamp: now(), event: event || action, entity: entity || 'Disruption',
      entityId: entityId || disruptionId, previousStatus, newStatus, severity
    }));
  } catch (e) { log.warn('Audit log failed:', e.message); }
}

export default cds.service.impl(async function (srv) {

  // Get db at request time (cds.db is available after connect)
  const getDb = () => cds.db;

  // ── getDashboardKPIs ────────────────────────────────────────────────────

  srv.on('getDashboardKPIs', async () => {
    try {
      const disruptions = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Disruptions'));
      const orders      = await cds.db.run(cds.ql.SELECT.from('hackfest.db.ProductionOrders'));
      const approvals   = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Approvals'));
      const monitoring  = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryMonitoring'));

      return {
        openDisruptions:    disruptions.filter(d => !['Resolved','Closed'].includes(d.status)).length,
        criticalDisruptions: disruptions.filter(d => d.severity === 'Critical' && !['Resolved','Closed'].includes(d.status)).length,
        atRiskProduction:   orders.filter(o => ['AtRisk','OnHold'].includes(o.status)).length,
        pendingApprovals:   approvals.filter(a => a.decision === 'Pending').length,
        activeRecoveries:   monitoring.filter(m => ['Initiated','InTransit','Delayed'].includes(m.status)).length
      };
    } catch (e) {
      log.error('getDashboardKPIs failed:', e.message);
      return { openDisruptions: 0, criticalDisruptions: 0, atRiskProduction: 0, pendingApprovals: 0, activeRecoveries: 0 };
    }
  });

  // ── analyzeDisruption ───────────────────────────────────────────────────

  srv.on('analyzeDisruption', async req => {
    const { disruptionId } = req.data;
    if (!disruptionId) return fail('disruptionId is required');
    log.info(`analyzeDisruption: ${disruptionId}`);
    try {
      const disruptions = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Disruptions').where({ ID: disruptionId }));
      const disruption  = disruptions[0];
      if (!disruption) return fail(`Disruption ${disruptionId} not found`);

      // Load associations manually
      if (disruption.supplier_ID) {
        const [s] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Suppliers').where({ ID: disruption.supplier_ID }));
        disruption.supplier = s;
      }
      if (disruption.material_ID) {
        const [m] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Inventory').where({ ID: disruption.material_ID }));
        disruption.material = m;
      }
      if (disruption.affectedPlant_ID) {
        const [p] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Plants').where({ ID: disruption.affectedPlant_ID }));
        disruption.affectedPlant = p;
      }

      const prevStatus = disruption.status;
      const triage     = await agents.triageAgent(getDb(), disruption);
      const impact     = await agents.impactAgent(getDb(), disruption);

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: disruptionId }).with({
        status:       'Analyzed',
        triageResult: JSON.stringify(triage.result),
        impactResult: JSON.stringify(impact.result)
      }));

      // Upsert financial impact
      const existing = await cds.db.run(cds.ql.SELECT.from('hackfest.db.FinancialImpacts').where({ 'disruption_ID': disruptionId }));
      const finData  = {
        estimatedLoss:   engine.safe(impact.result?.financialEstimate),
        claimableAmount: Math.round(engine.safe(impact.result?.financialEstimate) * 0.6),
        dailyLossRate:   Math.round(engine.safe(impact.result?.dailyConsumption) * engine.safe(impact.result?.material?.unitCost || 100)),
        currency: 'USD', lossCategory: 'Supply Shortage'
      };
      if (existing.length === 0) {
        await cds.db.run(cds.ql.INSERT.into('hackfest.db.FinancialImpacts').entries({ ID: newUUID(), disruption_ID: disruptionId, ...finData }));
      } else {
        await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.FinancialImpacts').where({ 'disruption_ID': disruptionId }).with(finData));
      }

      await createAudit(null, { disruptionId, action: 'Disruption Analyzed', actor: 'System', details: `Urgency: ${triage.result?.urgency}. Shortage: ${impact.result?.shortageQuantity} units.`, event: 'AnalysisComplete', entity: 'Disruption', entityId: disruptionId, previousStatus: prevStatus, newStatus: 'Analyzed' });

      return ok({ triage: triage.result, impact: impact.result });
    } catch (e) { log.error('analyzeDisruption failed:', e); return fail(e.message); }
  });

  // ── generateRecoveryPlans ───────────────────────────────────────────────

  srv.on('generateRecoveryPlans', async req => {
    const { disruptionId } = req.data;
    if (!disruptionId) return fail('disruptionId is required');
    log.info(`generateRecoveryPlans: ${disruptionId}`);
    try {
      const disruptions = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Disruptions').where({ ID: disruptionId }));
      const disruption  = disruptions[0];
      if (!disruption) return fail(`Disruption ${disruptionId} not found`);

      // Load associations
      if (disruption.supplier_ID) { const [s] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Suppliers').where({ ID: disruption.supplier_ID })); disruption.supplier = s; }
      if (disruption.material_ID) { const [m] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Inventory').where({ ID: disruption.material_ID })); disruption.material = m; }
      if (disruption.affectedPlant_ID) { const [p] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Plants').where({ ID: disruption.affectedPlant_ID })); disruption.affectedPlant = p; }

      let impact;
      if (disruption.impactResult) { impact = JSON.parse(disruption.impactResult); } else {
        const ia = await agents.impactAgent(getDb(), disruption); impact = ia.result;
      }

      const [destPlant] = disruption.affectedPlant_ID
        ? await cds.db.run(cds.ql.SELECT.from('hackfest.db.Plants').where({ ID: disruption.affectedPlant_ID }))
        : [null];

      // Delete existing plans
      const existingPlans = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ 'disruption_ID': disruptionId }));
      for (const ep of existingPlans) {
        try { await cds.db.run(cds.ql.DELETE.from('hackfest.db.RecoveryPlanSources').where({ 'recoveryPlan_ID': ep.ID })); } catch(e) {}
        try { await cds.db.run(cds.ql.DELETE.from('hackfest.db.RoutingOptions').where({ 'recoveryPlan_ID': ep.ID })); } catch(e) {}
        try { await cds.db.run(cds.ql.DELETE.from('hackfest.db.RiskAssessments').where({ 'recoveryPlan_ID': ep.ID })); } catch(e) {}
      }
      try { await cds.db.run(cds.ql.DELETE.from('hackfest.db.RecoveryPlans').where({ 'disruption_ID': disruptionId })); } catch(e) {}

      const rawPlans  = await agents.recoveryAgent(getDb(), disruption, impact);
      const savedPlans = [];

      for (const p of rawPlans) {
        const planId      = newUUID();
        const allocatedQty = engine.safe(p._recovery?.allocated);
        const totalCost   = engine.safe(p._cost?.totalCost);
        const riskScore   = engine.safe(p._risk?.riskScore);
        const riskLevel   = p._risk?.riskLevel || 'Medium';
        const transitDays = engine.safe(p._transitDays);
        const recovDays   = p._type === 'AlternateSupplier' ? engine.safe(p._alt?.leadTimeDays) : 1;

        const planRecord = {
          ID: planId, disruption_ID: disruptionId,
          planType: p._type, description: buildPlanDesc(p),
          recoveryQuantity: allocatedQty, estimatedCost: totalCost,
          estimatedRecoveryDays: recovDays + transitDays, transitDays, riskLevel, riskScore,
          feasibility: p._feasible ? 'Feasible' : 'Rejected',
          sourcePlantSafe: p._sourcePlantSafe !== false,
          costBreakdown: JSON.stringify(p._cost?.breakdown || {}),
          riskFactors: JSON.stringify(p._risk?.riskFactors || []),
          status: p._feasible ? 'Proposed' : 'Rejected',
          destinationPlant_ID: disruption.affectedPlant_ID || null,
          sourcePlant_ID: p._source?.ID || null,
          alternateSupplier_ID: p._alt?.ID || null
        };

        await cds.db.run(cds.ql.INSERT.into('hackfest.db.RecoveryPlans').entries(planRecord));

        // Sources
        if (p._feasible) {
          if (p._type === 'SisterPlantTransfer' && p._source) {
            await cds.db.run(cds.ql.INSERT.into('hackfest.db.RecoveryPlanSources').entries({ ID: newUUID(), recoveryPlan_ID: planId, sourceType: 'SisterPlant', sourceName: p._source.name, availableQuantity: engine.safe(p._validation?.effectiveTransfer), allocatedQuantity: allocatedQty, unitCost: 0, safeAfterTransfer: true, notes: p._validation?.reason }));
          }
          if (p._type === 'AlternateSupplier' && p._alt) {
            await cds.db.run(cds.ql.INSERT.into('hackfest.db.RecoveryPlanSources').entries({ ID: newUUID(), recoveryPlan_ID: planId, sourceType: 'AlternateSupplier', sourceName: p._alt.supplier?.name || 'Alternate', availableQuantity: engine.safe(p._alt.availableQuantity), allocatedQuantity: allocatedQty, unitCost: engine.safe(p._alt.unitCost), safeAfterTransfer: true, notes: `Lead time: ${p._alt.leadTimeDays} days` }));
          }
          if (p._type === 'Combination') {
            await cds.db.run(cds.ql.INSERT.into('hackfest.db.RecoveryPlanSources').entries({ ID: newUUID(), recoveryPlan_ID: planId, sourceType: 'Combined', sourceName: p._combinedFrom || 'Multiple Sources', availableQuantity: allocatedQty, allocatedQuantity: allocatedQty, unitCost: 0, safeAfterTransfer: true, notes: 'Combined recovery' }));
          }

          // Routing
          const routes = await agents.routingAgent(getDb(), planRecord, destPlant);
          for (const route of routes) {
            await cds.db.run(cds.ql.INSERT.into('hackfest.db.RoutingOptions').entries({ ID: newUUID(), recoveryPlan_ID: planId, ...route }));
          }

          // Risk assessment
          await cds.db.run(cds.ql.INSERT.into('hackfest.db.RiskAssessments').entries({
            ID: newUUID(), recoveryPlan_ID: planId,
            riskScore, riskLevel,
            inventoryRisk: p._risk?.inventoryRisk || 'Medium',
            sourcePlantRisk: p._risk?.sourcePlantRisk || 'Low',
            destinationRisk: 'Low',
            supplierRisk: p._risk?.supplierRisk || 'N/A',
            transitRisk: p._risk?.transitRisk || 'Medium',
            recoveryTimeRisk: p._risk?.recoveryTimeRisk || 'Medium',
            productionRisk: 'Medium',
            riskFactors: JSON.stringify(p._risk?.riskFactors || []),
            explanation: `Risk score: ${riskScore}/100. Level: ${riskLevel}.`
          }));
        }

        savedPlans.push({ ...planRecord, feasible: p._feasible, rejectionReason: p._rejectionReason });
      }

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: disruptionId }).with({ status: 'RecoveryPlanned' }));
      await createAudit(null, { disruptionId, action: 'Recovery Plans Generated', actor: 'Recovery Agent', details: `${savedPlans.filter(p => p.feasible).length} feasible option(s).`, event: 'RecoveryPlansGenerated', entity: 'Disruption', entityId: disruptionId, previousStatus: 'Analyzed', newStatus: 'RecoveryPlanned' });

      return ok({ plans: savedPlans, count: savedPlans.length });
    } catch (e) { log.error('generateRecoveryPlans failed:', e); return fail(e.message); }
  });

  // ── analyzeRoutes ───────────────────────────────────────────────────────

  srv.on('analyzeRoutes', async req => {
    const { disruptionId } = req.data;
    if (!disruptionId) return fail('disruptionId is required');
    try {
      const plans  = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ 'disruption_ID': disruptionId }));
      const result = [];
      for (const plan of plans.filter(p => p.status !== 'Rejected')) {
        const routes = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RoutingOptions').where({ 'recoveryPlan_ID': plan.ID }));
        result.push({ planId: plan.ID, planType: plan.planType, routes });
      }
      return ok(result);
    } catch (e) { return fail(e.message); }
  });

  // ── generateAIExplanation ───────────────────────────────────────────────

  srv.on('generateAIExplanation', async req => {
    const { disruptionId } = req.data;
    if (!disruptionId) return fail('disruptionId is required');
    log.info(`generateAIExplanation: ${disruptionId}`);
    try {
      const disruptions = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Disruptions').where({ ID: disruptionId }));
      const disruption  = disruptions[0];
      if (!disruption) return fail(`Disruption ${disruptionId} not found`);

      if (disruption.supplier_ID) { const [s] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Suppliers').where({ ID: disruption.supplier_ID })); disruption.supplier = s; }
      if (disruption.material_ID) { const [m] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Inventory').where({ ID: disruption.material_ID })); disruption.material = m; }

      const triage = disruption.triageResult ? JSON.parse(disruption.triageResult) : null;
      const impact = disruption.impactResult ? JSON.parse(disruption.impactResult) : null;

      const plans   = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ 'disruption_ID': disruptionId }));
      const planIds = plans.filter(p => p.status !== 'Rejected').map(p => p.ID);
      const routes  = planIds.length > 0 ? await cds.db.run(cds.ql.SELECT.from('hackfest.db.RoutingOptions').where({ 'recoveryPlan_ID': planIds })) : [];
      const risks   = planIds.length > 0 ? await cds.db.run(cds.ql.SELECT.from('hackfest.db.RiskAssessments').where({ 'recoveryPlan_ID': planIds })) : [];
      const [fin]   = await cds.db.run(cds.ql.SELECT.from('hackfest.db.FinancialImpacts').where({ 'disruption_ID': disruptionId }));

      const explanation = await agents.explanationAgent({
        disruption: { ID: disruption.ID, type: disruption.type, severity: disruption.severity, estimatedDelayDays: disruption.estimatedDelayDays, description: disruption.description, material: disruption.material, supplier: disruption.supplier },
        triage, impact,
        recoveryOptions: plans.map(p => ({ planType: p.planType, recoveryQuantity: p.recoveryQuantity, estimatedCost: p.estimatedCost, estimatedRecoveryDays: p.estimatedRecoveryDays, riskLevel: p.riskLevel, riskScore: p.riskScore, feasibility: p.feasibility, status: p.status })),
        routingOptions: routes, costAnalysis: fin, riskAnalysis: risks[0]
      });

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: disruptionId }).with({ aiExplanation: JSON.stringify(explanation) }));
      await createAudit(null, { disruptionId, action: 'AI Explanation Generated', actor: gemini.isAvailable() ? 'Gemini AI' : 'System Fallback', details: explanation.aiGenerated ? 'Gemini AI explanation generated' : `Fallback: ${explanation.unavailableReason}`, event: 'AIExplanationGenerated', entity: 'Disruption', entityId: disruptionId });

      return ok(explanation);
    } catch (e) { log.error('generateAIExplanation failed:', e); return fail(e.message); }
  });

  // ── selectRecoveryPlan ──────────────────────────────────────────────────

  srv.on('selectRecoveryPlan', async req => {
    const { planId } = req.data;
    if (!planId) return fail('planId is required');
    try {
      const [plan] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ ID: planId }));
      if (!plan) return fail(`Plan ${planId} not found`);
      const prevStatus = plan.status;

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryPlans').where({ 'disruption_ID': plan.disruption_ID }).with({ status: 'Proposed' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryPlans').where({ ID: planId }).with({ status: 'Selected' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: plan.disruption_ID }).with({ status: 'PendingApproval' }));

      const existing = await cds.db.run(cds.ql.SELECT.from('hackfest.db.Approvals').where({ 'recoveryPlan_ID': planId }));
      if (existing.length === 0) {
        await cds.db.run(cds.ql.INSERT.into('hackfest.db.Approvals').entries({ ID: newUUID(), recoveryPlan_ID: planId, decision: 'Pending', comments: '', approver: '', approverRole: 'Supply Chain Manager', selectedStrategy: plan.planType, totalCost: plan.estimatedCost, totalQuantity: plan.recoveryQuantity, estimatedDays: plan.estimatedRecoveryDays }));
      }

      await createAudit(null, { disruptionId: plan.disruption_ID, action: 'Recovery Plan Selected', actor: 'User', details: `Plan ${plan.planType} selected for approval.`, event: 'PlanSelected', entity: 'RecoveryPlan', entityId: planId, previousStatus: prevStatus, newStatus: 'Selected' });
      return ok({ planId, status: 'Selected' });
    } catch (e) { return fail(e.message); }
  });

  // ── approveRecovery ─────────────────────────────────────────────────────

  srv.on('approveRecovery', async req => {
    const { planId, approver, comments } = req.data;
    if (!planId) return fail('planId is required');
    log.info(`approveRecovery: ${planId} by ${approver}`);
    try {
      const [plan] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ ID: planId }));
      if (!plan) return fail(`Plan ${planId} not found`);
      const prevStatus = plan.status;

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryPlans').where({ ID: planId }).with({ status: 'Approved' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: plan.disruption_ID }).with({ status: 'Approved' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Approvals').where({ 'recoveryPlan_ID': planId }).with({ decision: 'Approved', comments: comments || '', decidedAt: now(), approver: approver || 'Manager', approverRole: 'Supply Chain Manager' }));

      await createAudit(null, { disruptionId: plan.disruption_ID, action: 'Recovery Approved', actor: approver || 'Manager', details: `${plan.planType} approved. Cost: $${plan.estimatedCost}. ${comments || ''}`, event: 'RecoveryApproved', entity: 'RecoveryPlan', entityId: planId, previousStatus: prevStatus, newStatus: 'Approved', severity: 'Info' });
      return ok({ planId, status: 'Approved', approver, decidedAt: now() });
    } catch (e) { return fail(e.message); }
  });

  // ── rejectRecovery ──────────────────────────────────────────────────────

  srv.on('rejectRecovery', async req => {
    const { planId, approver, comments } = req.data;
    if (!planId) return fail('planId is required');
    try {
      const [plan] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ ID: planId }));
      if (!plan) return fail(`Plan ${planId} not found`);
      const prevStatus = plan.status;

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryPlans').where({ ID: planId }).with({ status: 'Rejected' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: plan.disruption_ID }).with({ status: 'RecoveryPlanned' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Approvals').where({ 'recoveryPlan_ID': planId }).with({ decision: 'Rejected', comments: comments || '', decidedAt: now(), approver: approver || 'Manager', approverRole: 'Supply Chain Manager' }));

      await createAudit(null, { disruptionId: plan.disruption_ID, action: 'Recovery Rejected', actor: approver || 'Manager', details: `${plan.planType} rejected. Reason: ${comments || 'No reason provided'}`, event: 'RecoveryRejected', entity: 'RecoveryPlan', entityId: planId, previousStatus: prevStatus, newStatus: 'Rejected', severity: 'Warning' });
      return ok({ planId, status: 'Rejected' });
    } catch (e) { return fail(e.message); }
  });

  // ── startRecovery ───────────────────────────────────────────────────────

  srv.on('startRecovery', async req => {
    const { planId } = req.data;
    if (!planId) return fail('planId is required');
    try {
      const [plan] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ ID: planId }));
      if (!plan) return fail(`Plan ${planId} not found`);
      if (plan.status !== 'Approved') return fail(`Plan must be Approved. Current: ${plan.status}`);

      const prevStatus = plan.status;
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryPlans').where({ ID: planId }).with({ status: 'InProgress' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: plan.disruption_ID }).with({ status: 'InProgress' }));

      const existing = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryMonitoring').where({ 'recoveryPlan_ID': planId }));
      const eta      = agents.addDays(plan.estimatedRecoveryDays || 5);
      if (existing.length === 0) {
        await cds.db.run(cds.ql.INSERT.into('hackfest.db.RecoveryMonitoring').entries({ ID: newUUID(), recoveryPlan_ID: planId, status: 'Initiated', plannedQuantity: plan.recoveryQuantity, recoveredQuantity: 0, completionPercent: 0, expectedArrival: `${eta}T00:00:00Z`, lastUpdated: now(), notes: 'Recovery initiated', updatedBy: 'System' }));
      } else {
        await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryMonitoring').where({ 'recoveryPlan_ID': planId }).with({ status: 'Initiated', lastUpdated: now() }));
      }

      await createAudit(null, { disruptionId: plan.disruption_ID, action: 'Recovery Started', actor: 'System', details: `${plan.planType} execution initiated.`, event: 'RecoveryStarted', entity: 'RecoveryPlan', entityId: planId, previousStatus: prevStatus, newStatus: 'InProgress' });
      return ok({ planId, status: 'InProgress' });
    } catch (e) { return fail(e.message); }
  });

  // ── updateRecoveryStatus ────────────────────────────────────────────────

  srv.on('updateRecoveryStatus', async req => {
    const { monitoringId, status, recoveredQuantity, notes, updatedBy } = req.data;
    if (!monitoringId) return fail('monitoringId is required');
    try {
      const [mon] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryMonitoring').where({ ID: monitoringId }));
      if (!mon) return fail(`Monitoring record ${monitoringId} not found`);

      const planned   = engine.safe(mon.plannedQuantity);
      const recovered = engine.safe(recoveredQuantity);
      const pct       = Math.min(Math.round(engine.safeDivide(recovered, planned, 0) * 100), 100);
      const prevStatus = mon.status;

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryMonitoring').where({ ID: monitoringId }).with({ status: status || mon.status, recoveredQuantity: recovered, completionPercent: pct, lastUpdated: now(), notes: notes || '', updatedBy: updatedBy || 'User' }));

      let plan = {};
      try {
        const resPlan = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ ID: mon.recoveryPlan_ID }));
        if (resPlan && resPlan.length > 0) plan = resPlan[0];
      } catch (e) {}
      await createAudit(null, { disruptionId: plan?.disruption_ID, action: 'Recovery Status Updated', actor: updatedBy || 'User', details: `Recovered ${recovered}/${planned} units (${pct}%). Status: ${status}. ${notes || ''}`, event: 'MonitoringUpdated', entity: 'RecoveryMonitoring', entityId: monitoringId, previousStatus: prevStatus, newStatus: status });

      return ok({ monitoringId, status, recoveredQuantity: recovered, completionPercent: pct });
    } catch (e) { return fail(e.message); }
  });

  // ── completeRecovery ────────────────────────────────────────────────────

  srv.on('completeRecovery', async req => {
    const { planId } = req.data;
    if (!planId) return fail('planId is required');
    try {
      const [plan] = await cds.db.run(cds.ql.SELECT.from('hackfest.db.RecoveryPlans').where({ ID: planId }));
      if (!plan) return fail(`Plan ${planId} not found`);
      const prevStatus = plan.status;

      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryPlans').where({ ID: planId }).with({ status: 'Completed' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.Disruptions').where({ ID: plan.disruption_ID }).with({ status: 'Resolved' }));
      await cds.db.run(cds.ql.UPDATE.entity('hackfest.db.RecoveryMonitoring').where({ 'recoveryPlan_ID': planId }).with({ status: 'Completed', recoveredQuantity: plan.recoveryQuantity, completionPercent: 100, actualArrival: now(), lastUpdated: now() }));

      await createAudit(null, { disruptionId: plan.disruption_ID, action: 'Recovery Completed', actor: 'System', details: `${plan.planType} completed. ${plan.recoveryQuantity} units recovered.`, event: 'RecoveryCompleted', entity: 'RecoveryPlan', entityId: planId, previousStatus: prevStatus, newStatus: 'Completed' });
      return ok({ planId, status: 'Completed', resolvedAt: now() });
    } catch (e) { return fail(e.message); }
  });

});

// ── Helpers ───────────────────────────────────────────────────────────────

function buildPlanDesc(p) {
  if (p._type === 'SisterPlantTransfer') {
    if (!p._feasible) return `Transfer from ${p._source?.name} — REJECTED: ${p._rejectionReason}`;
    return `Transfer ${p._recovery?.allocated} units from ${p._source?.name} (${p._source?.location}). Transit: ${p._transitDays} days.`;
  }
  if (p._type === 'AlternateSupplier') {
    return `Source ${p._recovery?.allocated} units from ${p._alt?.supplier?.name || 'Alternate Supplier'}. Lead time: ${p._alt?.leadTimeDays} days. Unit cost: $${p._alt?.unitCost}.`;
  }
  if (p._type === 'Combination') return `Combined recovery from ${p._combinedFrom}. Total: ${p._recovery?.allocated} units.`;
  return p._type;
}
