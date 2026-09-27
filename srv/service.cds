using { hackfest.db as db } from '../db/schema';

@path: '/odata/v4/hackfest'
service HackfestService {

    // ── Core supply-chain data ──────────────────────────────────────────────
    entity Suppliers            as projection on db.Suppliers;
    entity Inventory            as projection on db.Inventory;
    entity Disruptions          as projection on db.Disruptions;

    // ── Impact analysis ─────────────────────────────────────────────────────
    entity Plants               as projection on db.Plants;
    entity ProductionOrders     as projection on db.ProductionOrders;

    // ── Recovery planning ───────────────────────────────────────────────────
    entity AlternateSuppliers   as projection on db.AlternateSuppliers;
    entity RecoveryPlans        as projection on db.RecoveryPlans;
    entity RecoveryPlanSources  as projection on db.RecoveryPlanSources;

    // ── Recovery analysis ───────────────────────────────────────────────────
    entity RoutingOptions       as projection on db.RoutingOptions;
    entity RiskAssessments      as projection on db.RiskAssessments;

    // ── Financial and approval data ─────────────────────────────────────────
    entity FinancialImpacts     as projection on db.FinancialImpacts;
    entity RecoveryActions      as projection on db.RecoveryActions;
    entity Approvals            as projection on db.Approvals;

    // ── Recovery monitoring and audit ───────────────────────────────────────
    entity RecoveryMonitoring   as projection on db.RecoveryMonitoring;
    entity AuditLogs            as projection on db.AuditLogs;

    // ── Dashboard KPI query ─────────────────────────────────────────────────
    function getDashboardKPIs() returns {
        openDisruptions     : Integer;
        atRiskProduction    : Integer;
        pendingApprovals    : Integer;
        activeRecoveries    : Integer;
        criticalDisruptions : Integer;
    };

    // ── Core workflow actions ───────────────────────────────────────────────

    /**
     * Run full triage + impact analysis for a disruption.
     */
    action analyzeDisruption(disruptionId : UUID) returns LargeString;

    /**
     * Generate all feasible recovery options for a disruption.
     */
    action generateRecoveryPlans(disruptionId : UUID) returns LargeString;

    /**
     * Analyse routing for all recovery plans of a disruption.
     */
    action analyzeRoutes(disruptionId : UUID) returns LargeString;

    /**
     * Call Gemini to generate a natural-language explanation.
     */
    action generateAIExplanation(disruptionId : UUID) returns LargeString;

    /**
     * Select a recovery plan and move it to PendingApproval.
     */
    action selectRecoveryPlan(planId : UUID) returns LargeString;

    /**
     * Approve a selected recovery plan.
     */
    action approveRecovery(planId : UUID, approver : String, comments : String) returns LargeString;

    /**
     * Reject a selected recovery plan.
     */
    action rejectRecovery(planId : UUID, approver : String, comments : String) returns LargeString;

    /**
     * Start execution of an approved recovery plan.
     */
    action startRecovery(planId : UUID) returns LargeString;

    /**
     * Update the monitoring status of a recovery.
     */
    action updateRecoveryStatus(monitoringId : UUID, status : String, recoveredQuantity : Decimal, notes : String, updatedBy : String) returns LargeString;

    /**
     * Mark a recovery as fully completed.
     */
    action completeRecovery(planId : UUID) returns LargeString;
}