namespace hackfest.db;

entity Suppliers {
    key ID          : UUID;
    name            : String(100);
    location        : String(100);
    riskStatus      : String(20);
    leadTimeDays    : Integer;
}

entity Inventory {
    key ID          : UUID;
    materialCode    : String(50);
    materialName    : String(100);
    quantity        : Decimal(15,2);
    reorderLevel    : Decimal(15,2);

    supplier        : Association to Suppliers;
}

entity Disruptions {
    key ID              : UUID;
    type                : String(50);
    severity            : String(20);
    description         : String(500);
    status              : String(30);
    detectedAt          : Timestamp;
    estimatedDelayDays  : Integer;

    supplier            : Association to Suppliers;
    material            : Association to Inventory;
}

entity FinancialImpacts {
    key ID              : UUID;
    estimatedLoss       : Decimal(15,2);
    claimableAmount     : Decimal(15,2);
    currency            : String(3);

    disruption          : Association to Disruptions;
}

entity RecoveryActions {
    key ID                  : UUID;
    action                  : String(200);
    recommendation          : String(500);
    status                  : String(30);
    estimatedRecoveryValue  : Decimal(15,2);

    disruption              : Association to Disruptions;
}