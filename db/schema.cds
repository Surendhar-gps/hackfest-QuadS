namespace hackfest.db;

// ─── CORE ──────────────────────────────────────────────────────────────────

entity Suppliers {
    key ID              : UUID;
    name                : String(100);
    location            : String(100);
    country             : String(50);
    riskStatus          : String(20);  // Low | Medium | High | Critical
    leadTimeDays        : Integer;
    contactEmail        : String(100);
    annualVolume        : Decimal(15,2);
    status              : String(20) default 'Active';  // Active | Suspended | Inactive
}

entity Inventory {
    key ID              : UUID;
    materialCode        : String(50);
    materialName        : String(100);
    materialCategory    : String(50);
    quantity            : Decimal(15,2);
    reorderLevel        : Decimal(15,2);
    safetyStock         : Decimal(15,2);
    unitOfMeasure       : String(10) default 'PCS';
    unitCost            : Decimal(15,2);
    dailyConsumptionRate : Decimal(10,2);

    supplier            : Association to Suppliers;
    plant               : Association to Plants;
}

entity Disruptions {
    key ID              : UUID;
    type                : String(50);   // Logistics | Supplier | Natural | Geopolitical | Quality
    severity            : String(20);   // Critical | High | Medium | Low
    description         : String(500);
    status              : String(30);   // Detected | Analyzing | Triaged | RecoveryPlanned | PendingApproval | Approved | InProgress | Resolved
    detectedAt          : Timestamp;
    estimatedDelayDays  : Integer;
    affectedPlant       : Association to Plants;

    // Analysis results stored as JSON text for flexibility
    triageResult        : LargeString;
    impactResult        : LargeString;
    aiExplanation       : LargeString;

    supplier            : Association to Suppliers;
    material            : Association to Inventory;
}

// ─── IMPACT ────────────────────────────────────────────────────────────────

entity Plants {
    key ID              : UUID;
    name                : String(100);
    location            : String(100);
    country             : String(50);
    plantCode           : String(20);
    plantType           : String(30);   // Assembly | Manufacturing | Distribution | Warehouse
    dailyCapacity       : Integer;
    dailyDemand         : Integer;
    safetyStockDays     : Integer default 3;
    operatingStatus     : String(30);   // Operational | AtRisk | Disrupted | Shutdown
    isSisterPlant       : Boolean default false;
}

entity ProductionOrders {
    key ID              : UUID;
    orderNumber         : String(50);
    requiredQuantity    : Decimal(15,2);
    dueDate             : Date;
    status              : String(30);   // Planned | Confirmed | AtRisk | OnHold | Completed | Cancelled
    priority            : String(20);   // High | Medium | Low

    material            : Association to Inventory;
    plant               : Association to Plants;
    disruption          : Association to Disruptions;
}

// ─── RECOVERY ──────────────────────────────────────────────────────────────

entity AlternateSuppliers {
    key ID              : UUID;
    availableQuantity   : Decimal(15,2);
    leadTimeDays        : Integer;
    unitCost            : Decimal(15,2);
    transitDays         : Integer;
    status              : String(30);   // Available | Limited | Unavailable
    certificationStatus : String(30);   // Certified | Pending | Not Certified
    notes               : String(500);

    supplier            : Association to Suppliers;
    material            : Association to Inventory;
}

entity RecoveryPlans {
    key ID                  : UUID;
    planType                : String(50);   // SisterPlantTransfer | AlternateSupplier | Combination | EmergencyProcurement
    description             : String(500);
    recoveryQuantity        : Decimal(15,2);
    estimatedCost           : Decimal(15,2);
    estimatedRecoveryDays   : Integer;
    transitDays             : Integer;
    riskLevel               : String(20);   // Low | Medium | High | Critical
    riskScore               : Decimal(5,2);
    feasibility             : String(20);   // Feasible | Marginal | Rejected
    sourcePlantSafe         : Boolean;
    costBreakdown           : LargeString;  // JSON
    riskFactors             : LargeString;  // JSON array
    status                  : String(30);   // Proposed | Selected | PendingApproval | Approved | Rejected | InProgress | Completed

    disruption              : Association to Disruptions;
    sourcePlant             : Association to Plants;
    destinationPlant        : Association to Plants;
    alternateSupplier       : Association to AlternateSuppliers;
}

entity RecoveryPlanSources {
    key ID                  : UUID;
    sourceType              : String(30);   // SisterPlant | AlternateSupplier | EmergencyStock
    sourceName              : String(100);
    availableQuantity       : Decimal(15,2);
    allocatedQuantity       : Decimal(15,2);
    unitCost                : Decimal(15,2);
    safeAfterTransfer       : Boolean;
    notes                   : String(500);

    recoveryPlan            : Association to RecoveryPlans;
}

// ─── ANALYSIS ──────────────────────────────────────────────────────────────

entity RoutingOptions {
    key ID                  : UUID;
    sourceLocation          : String(100);
    destinationLocation     : String(100);
    distanceKm              : Decimal(10,2);
    transitDays             : Decimal(5,2);
    estimatedArrival        : Date;
    transportMode           : String(50);   // Road | Rail | Air | Sea | Multimodal
    transportCost           : Decimal(15,2);
    routeRisk               : String(20);   // Low | Medium | High
    routeStatus             : String(30);   // Feasible | Restricted | Unavailable
    feasibilityNotes        : String(300);

    recoveryPlan            : Association to RecoveryPlans;
}

entity RiskAssessments {
    key ID                  : UUID;
    riskScore               : Decimal(5,2);
    riskLevel               : String(20);   // Low | Medium | High | Critical
    inventoryRisk           : String(20);
    sourcePlantRisk         : String(20);
    destinationRisk         : String(20);
    supplierRisk            : String(20);
    transitRisk             : String(20);
    recoveryTimeRisk        : String(20);
    productionRisk          : String(20);
    riskFactors             : LargeString;  // JSON array of {factor, level, description}
    explanation             : String(1000);

    recoveryPlan            : Association to RecoveryPlans;
}

// ─── FINANCIAL ─────────────────────────────────────────────────────────────

entity FinancialImpacts {
    key ID              : UUID;
    estimatedLoss       : Decimal(15,2);
    claimableAmount     : Decimal(15,2);
    dailyLossRate       : Decimal(15,2);
    currency            : String(3) default 'USD';
    lossCategory        : String(50);
    breakdownJson       : LargeString;  // JSON

    disruption          : Association to Disruptions;
}

entity RecoveryActions {
    key ID                  : UUID;
    action                  : String(200);
    recommendation          : String(500);
    status                  : String(30);   // Pending | InProgress | Completed | Cancelled
    estimatedRecoveryValue  : Decimal(15,2);
    priority                : String(20);   // High | Medium | Low
    dueDate                 : Date;
    assignedTo              : String(100);

    disruption              : Association to Disruptions;
    recoveryPlan            : Association to RecoveryPlans;
}

// ─── APPROVAL ──────────────────────────────────────────────────────────────

entity Approvals {
    key ID                  : UUID;
    decision                : String(30);   // Approved | Rejected | Pending
    comments                : String(500);
    decidedAt               : Timestamp;
    approver                : String(100);
    approverRole            : String(50);
    selectedStrategy        : String(100);
    totalCost               : Decimal(15,2);
    totalQuantity           : Decimal(15,2);
    estimatedDays           : Integer;

    recoveryPlan            : Association to RecoveryPlans;
}

// ─── MONITORING ────────────────────────────────────────────────────────────

entity RecoveryMonitoring {
    key ID                  : UUID;
    status                  : String(30);   // Initiated | InTransit | Delayed | Delivered | Completed
    plannedQuantity         : Decimal(15,2);
    recoveredQuantity       : Decimal(15,2);
    expectedArrival         : Timestamp;
    actualArrival           : Timestamp;
    delayDays               : Integer default 0;
    completionPercent       : Decimal(5,2) default 0;
    lastUpdated             : Timestamp;
    notes                   : String(500);
    updatedBy               : String(100);

    recoveryPlan            : Association to RecoveryPlans;
}

// ─── AUDIT ─────────────────────────────────────────────────────────────────

entity AuditLogs {
    key ID              : UUID;
    action              : String(100);
    actor               : String(100);
    details             : String(1000);
    timestamp           : Timestamp;
    event               : String(100);
    entity              : String(50);
    entityId            : String(100);
    previousStatus      : String(50);
    newStatus           : String(50);
    severity            : String(20) default 'Info';  // Info | Warning | Error | Critical

    disruption          : Association to Disruptions;
}