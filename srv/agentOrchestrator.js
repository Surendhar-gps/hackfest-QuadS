/**
 * agentOrchestrator.js — ES Module version
 *
 * Supply Chain Agent Orchestration Layer.
 * Logical agents (NOT separate deployed services).
 */

import * as engine from './supplyChainEngine.js';
import * as gemini from './geminiModel.js';

const log = {
  info:  (msg, ...a) => console.log(`[Agent][INFO]  ${msg}`, ...a),
  warn:  (msg, ...a) => console.warn(`[Agent][WARN]  ${msg}`, ...a),
  error: (msg, ...a) => console.error(`[Agent][ERROR] ${msg}`, ...a)
};

export function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Math.round(engine.safe(days)));
  return d.toISOString().split('T')[0];
}

// ── Triage Agent ──────────────────────────────────────────────────────────

export async function triageAgent(db, disruption) {
  log.info(`Triage Agent — disruption ${disruption.ID}`);
  try {
    const result = await engine.runTriage(db, disruption);
    log.info(`Triage complete. Urgency: ${result.urgency}`);
    return { success: true, result };
  } catch (err) {
    log.error('Triage agent failed:', err.message);
    return { success: false, error: err.message, result: null };
  }
}

// ── Impact Agent ──────────────────────────────────────────────────────────

export async function impactAgent(db, disruption) {
  log.info(`Impact Agent — disruption ${disruption.ID}`);
  try {
    const result = await engine.runImpactAnalysis(db, disruption);
    log.info(`Impact complete. Shortage: ${result.shortageQuantity}, Days of stock: ${result.daysOfStock}`);
    return { success: true, result };
  } catch (err) {
    log.error('Impact agent failed:', err.message);
    return { success: false, error: err.message, result: null };
  }
}

// ── Recovery Agent ────────────────────────────────────────────────────────

export async function recoveryAgent(db, disruption, impact) {
  log.info(`Recovery Agent — disruption ${disruption.ID}`);
  const plans      = [];
  const materialId = disruption.material_ID || disruption.material?.ID;
  const plantId    = disruption.affectedPlant_ID || disruption.affectedPlant?.ID;
  const delayDays  = engine.safe(disruption.estimatedDelayDays);
  const shortage   = engine.safe(impact?.shortageQuantity) || 100;

  // ── Sister Plant Transfer ──────────────────────────────────────────────
  const sisterPlants = await engine.findSisterPlants(db, plantId);
  log.info(`Found ${sisterPlants.length} sister plant(s)`);

  for (const sister of sisterPlants) {
    const validation = await engine.validateSisterPlantTransfer(db, sister.ID, shortage, delayDays);
    if (!validation.feasible) {
      log.warn(`Sister plant ${sister.name} rejected: ${validation.reason}`);
      plans.push({ _type: 'SisterPlantTransfer', _source: sister, _feasible: false, _rejectionReason: validation.reason, _validation: validation });
      continue;
    }
    const recovery    = engine.calculateRecoveryQuantity(validation.effectiveTransfer, shortage);
    const distKm      = Math.round(Math.random() * 300 + 150);
    const transitDays = engine.calculateTransitTime(distKm, 'Road');
    const cost        = engine.calculateRecoveryCost({ strategy: 'SisterPlantTransfer', quantity: recovery.allocated, distanceKm: distKm, transportMode: 'Road' });
    const risk        = engine.calculateRisk({ strategy: 'SisterPlantTransfer', shortageQuantity: shortage, allocatedQuantity: recovery.allocated, recoveryDays: 1, delayDays, sourcePlantSafe: true, daysOfStock: engine.safe(impact?.daysOfStock), transitDays });
    plans.push({ _type: 'SisterPlantTransfer', _source: sister, _feasible: true, _validation: validation, _recovery: recovery, _distKm: distKm, _transitDays: transitDays, _cost: cost, _risk: risk, _sourcePlantSafe: true });
    log.info(`Sister plant ${sister.name}: ${recovery.allocated} units, $${cost.totalCost}, risk ${risk.riskLevel}`);
  }

  // ── Alternate Supplier ─────────────────────────────────────────────────
  const altSuppliers = await engine.findAlternateSuppliers(db, materialId);
  log.info(`Found ${altSuppliers.length} alternate supplier(s)`);

  for (const alt of altSuppliers) {
    // Load supplier data
    let altFull = alt;
    try {
      const res1 = await db.read('hackfest.db.AlternateSuppliers').where({ ID: alt.ID });
      if (res1 && res1.length > 0) altFull = res1[0];
    } catch (e) {}

    let supData = {};
    if (altFull?.supplier_ID) {
      try {
        const res2 = await db.read('hackfest.db.Suppliers').where({ ID: altFull.supplier_ID });
        if (res2 && res2.length > 0) supData = res2[0];
      } catch (e) {}
    }

    const available   = engine.safe(alt.availableQuantity);
    if (available <= 0) continue;
    const recovery    = engine.calculateRecoveryQuantity(available, shortage);
    const distKm      = Math.round(Math.random() * 600 + 300);
    const transitDays = engine.safe(alt.transitDays) || engine.calculateTransitTime(distKm, 'Road');
    const cost        = engine.calculateRecoveryCost({ strategy: 'AlternateSupplier', quantity: recovery.allocated, unitCost: engine.safe(alt.unitCost), distanceKm: distKm, transportMode: 'Road', isExpedited: transitDays <= 3 });
    const risk        = engine.calculateRisk({ strategy: 'AlternateSupplier', shortageQuantity: shortage, allocatedQuantity: recovery.allocated, recoveryDays: engine.safe(alt.leadTimeDays), delayDays, sourcePlantSafe: true, supplierRiskStatus: supData?.riskStatus || 'Medium', daysOfStock: engine.safe(impact?.daysOfStock), transitDays });
    plans.push({ _type: 'AlternateSupplier', _alt: { ...alt, supplier: supData }, _feasible: recovery.allocated > 0, _recovery: recovery, _distKm: distKm, _transitDays: transitDays, _cost: cost, _risk: risk, _sourcePlantSafe: true });
    log.info(`Alt supplier ${supData?.name || alt.ID}: ${recovery.allocated} units, $${cost.totalCost}, risk ${risk.riskLevel}`);
  }

  // ── Combination ────────────────────────────────────────────────────────
  const feasibleSister   = plans.filter(p => p._type === 'SisterPlantTransfer' && p._feasible);
  const feasibleSupplier = plans.filter(p => p._type === 'AlternateSupplier' && p._feasible);

  if (feasibleSister.length > 0 && feasibleSupplier.length > 0) {
    const best  = feasibleSister[0];
    const bestS = feasibleSupplier[0];
    const totalQty = engine.safe(best._recovery?.allocated) + engine.safe(bestS._recovery?.allocated);
    if (totalQty < shortage) {
      const distKm      = Math.round((best._distKm + bestS._distKm) / 2);
      const transitDays = Math.max(best._transitDays, bestS._transitDays);
      const comboCost   = engine.calculateRecoveryCost({ strategy: 'Combination', quantity: Math.min(totalQty, shortage), unitCost: engine.safe(bestS._alt?.unitCost), distanceKm: distKm });
      const comboRisk   = engine.calculateRisk({ strategy: 'Combination', shortageQuantity: shortage, allocatedQuantity: Math.min(totalQty, shortage), recoveryDays: engine.safe(bestS._alt?.leadTimeDays), delayDays, sourcePlantSafe: true, supplierRiskStatus: bestS._alt?.supplier?.riskStatus || 'Medium', daysOfStock: engine.safe(impact?.daysOfStock), transitDays });
      plans.push({ _type: 'Combination', _feasible: true, _combinedFrom: [best._source?.name, bestS._alt?.supplier?.name].filter(Boolean).join(' + '), _recovery: { allocated: Math.min(totalQty, shortage), requested: shortage, fullyCovers: totalQty >= shortage }, _distKm: distKm, _transitDays: transitDays, _cost: comboCost, _risk: comboRisk, _sourcePlantSafe: true });
    }
  }

  log.info(`Recovery agent generated ${plans.length} option(s)`);
  return plans;
}

// ── Routing Agent ─────────────────────────────────────────────────────────

export async function routingAgent(db, recoveryPlan, destPlant) {
  log.info(`Routing Agent — plan ${recoveryPlan.ID}`);
  const dest = destPlant?.location || 'Destination Plant';

  let sourceName = 'Source';
  if (recoveryPlan.sourcePlant_ID) {
    try {
      const res3 = await db.read('hackfest.db.Plants').where({ ID: recoveryPlan.sourcePlant_ID });
      if (res3 && res3.length > 0) sourceName = res3[0].location || 'Sister Plant';
    } catch (e) {}
  } else if (recoveryPlan.alternateSupplier_ID) {
    let as_ = {};
    try {
      const res4 = await db.read('hackfest.db.AlternateSuppliers').where({ ID: recoveryPlan.alternateSupplier_ID });
      if (res4 && res4.length > 0) as_ = res4[0];
    } catch (e) {}
    if (as_?.supplier_ID) {
      try {
        const res5 = await db.read('hackfest.db.Suppliers').where({ ID: as_.supplier_ID });
        if (res5 && res5.length > 0) sourceName = res5[0].location || 'Alternate Supplier';
      } catch (e) {}
    }
  }

  const distKm      = Math.round(Math.random() * 400 + 150);
  const mode        = recoveryPlan.planType === 'SisterPlantTransfer' ? 'Road' : 'Multimodal';
  const transitDays = engine.calculateTransitTime(distKm, mode);

  return [{
    sourceLocation:      sourceName,
    destinationLocation: dest,
    distanceKm:          distKm,
    transitDays,
    estimatedArrival:    addDays(transitDays),
    transportMode:       mode,
    transportCost:       Math.round(distKm * 0.85 + engine.safe(recoveryPlan.recoveryQuantity) * 1.2),
    routeRisk:           distKm > 600 ? 'High' : distKm > 300 ? 'Medium' : 'Low',
    routeStatus:         'Feasible',
    feasibilityNotes:    `${distKm}km via ${mode} — transit ${transitDays} day(s)`
  }];
}

// ── Explanation Agent ─────────────────────────────────────────────────────

export async function explanationAgent(context) {
  log.info(`Explanation Agent — disruption ${context.disruption?.ID}`);

  if (!gemini.isAvailable()) {
    log.warn('Gemini not configured — returning deterministic fallback');
    return buildFallbackExplanation(context);
  }

  try {
    const result = await gemini.generateExplanation(context);
    if (result.fallback) {
      log.warn('Gemini fallback:', result.error);
      return buildFallbackExplanation(context, result.error);
    }
    return { ...result, aiGenerated: true, timestamp: new Date().toISOString() };
  } catch (err) {
    log.error('Explanation agent failed:', err.message);
    return buildFallbackExplanation(context, err.message);
  }
}

export function buildFallbackExplanation(ctx, errorMsg) {
  const disruption = ctx.disruption || {};
  const impact     = ctx.impact    || {};
  const plans      = ctx.recoveryOptions || [];
  const bestPlan   = plans.find(p => p.status === 'Proposed') || plans[0] || {};

  return {
    aiGenerated: false, fallback: true,
    unavailableReason: errorMsg || 'AI explanation unavailable. Deterministic supply-chain analysis is still available.',
    executiveSummary: `A ${disruption.severity || 'high'}-severity ${disruption.type || 'supply chain'} disruption has been detected affecting ${disruption.material?.materialName || 'critical materials'} with an estimated delay of ${disruption.estimatedDelayDays || '?'} days. Immediate recovery action is required.`,
    situation:          `Type: ${disruption.type}. Severity: ${disruption.severity}. Delay: ${disruption.estimatedDelayDays} days. ${disruption.description || ''}`,
    impactExplanation:  `Current inventory: ${impact.currentInventory} units. Daily consumption: ${impact.dailyConsumption} units/day. Days of stock: ${impact.daysOfStock}. Shortage: ${impact.shortageQuantity} units. ${impact.affectedProductionOrders} production orders affected.`,
    recoveryExplanation: `${plans.length} recovery option(s) generated. Best option: ${bestPlan.planType || 'N/A'} — Cost: $${bestPlan.estimatedCost || 0}, Recovery: ${bestPlan.estimatedRecoveryDays || 0} days.`,
    costExplanation:    `Total estimated cost: $${bestPlan.estimatedCost || 0} USD. Breakdown available in Cost & Risk section.`,
    riskExplanation:    `Overall risk level: ${bestPlan.riskLevel || 'Medium'}. Score: ${bestPlan.riskScore || 0}/100.`,
    assumptions: ['Daily consumption derived from inventory data', 'Transit times calculated from distance and mode', 'Sister plant safety threshold: 3 days safety stock', 'Cost estimates based on standard rates'],
    tradeoffs: 'Compare options by cost, recovery time, and risk. Lower-cost options may have higher risk or longer lead times.',
    nextAction: 'Review recovery options and select the most appropriate plan for manager approval.',
    confidence: 'medium', urgency: disruption.severity === 'Critical' ? 'Critical' : disruption.severity || 'High',
    timestamp: new Date().toISOString()
  };
}
