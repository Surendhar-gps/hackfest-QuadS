using { hackfest.db as db } from '../db/schema';

@path: '/odata/v4/hackfest'
service HackfestService {

    entity Suppliers        as projection on db.Suppliers;
    entity Inventory        as projection on db.Inventory;
    entity Disruptions      as projection on db.Disruptions;
    entity FinancialImpacts as projection on db.FinancialImpacts;
    entity RecoveryActions  as projection on db.RecoveryActions;

}