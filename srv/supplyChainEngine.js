/**
 * supplyChainEngine.js — ES Module version
 *
 * Deterministic Supply Chain Business Engine.
 * All numerical values used in analysis come from here.
 * Gemini NEVER invents these numbers — it only explains them.
 */

// ── Safe math helpers ─────────────────────────────────────────────────────

export const safe = (v, fallback = 0) => {
  if (v === null || v === undefined || isNaN(Number(v)) || !isFinite(Number(v))) return fallback;
  return Number(v);
};

export const safeDivide = (numerator, denominator, fallback = 0) => {
  if (!denominator || Number(denominator) === 0) return fallback;
  const result = Number(numerator) / Number(denominator);
  return isFinite(result) ? result : fallback;
};

// ── Retrieval helpers ─────────────────────────────────────────────────────

export function getAffectedInventory(db, materialId) {
  if (!materialId) return Promise.resolve(null);
  return db.read('hackfest.db.Inventory').where({ ID: materialId }).then(r => r[0] || null);
}

export async function getAffectedProductionOrders(db, materialId, plantId) {
  if (!materialId && !plantId) return [];
  try {
    let query = db.read('hackfest.db.ProductionOrders');
    if (materialId && plantId) {
      return await query.where({ 'material_ID': materialId });
    } else if (materialId) {
      return await query.where({ 'material_ID': materialId });
    } else {
      return await query.where({ 'plant_ID': plantId });
    }
  } catch (e) {
    return [];
  }
}

export async function findSisterPlants(db, excludePlantId) {
  try {
    const plants = await db.read('hackfest.db.Plants').where({ isSisterPlant: true });
    return plants.filter(p => p.ID !== excludePlantId);
  } catch (e) {
    return [];
  }
}

export async function findAlternateSuppliers(db, materialId) {
  if (!materialId) return [];
  try {
    const rows = await db.read('hackfest.db.AlternateSuppliers').where({ 'material_ID': materialId });
    return rows.filter(r => r.status !== 'Unavailable');
  } catch (e) {
    return [];
  }
}

// ── Calculations ──────────────────────────────────────────────────────────

export function calculateDailyConsumption(inventory) {
  if (safe(inventory?.dailyConsumptionRate) > 0) {
    return safe(inventory.dailyConsumptionRate);
  }
  return Math.max(safe(inventory?.quantity) * 0.05, 5);
}

export function calculateDaysOfStock(currentInventory, dailyConsumption) {
  const inv  = safe(currentInventory);
  const cons = safe(dailyConsumption);
  if (inv === 0) return 0;
  return safeDivide(inv, cons, 999);
}

export function calculateShortage(requiredQuantity, availableQuantity) {
  const shortage = safe(requiredQuantity) - safe(availableQuantity);
  return Math.max(shortage, 0);
}

export function calculateStockout(currentInventory, dailyConsumption, delayDays) {
  const inv   = safe(currentInventory);
  const cons  = safe(dailyConsumption);
  const delay = safe(delayDays);
  const daysOfStock = safeDivide(inv, cons, inv > 0 ? 999 : 0);
  const stockoutDay = Math.floor(daysOfStock);
  const stockoutDuringDisruption = stockoutDay < delay;
  return {
    daysOfStock:               Math.round(daysOfStock * 10) / 10,
    stockoutDuringDisruption,
    stockoutDay,
    delayDays:                 delay,
    criticalGapDays:           stockoutDuringDisruption ? delay - stockoutDay : 0
  };
}

export function calculateProductionRisk(productionOrders, currentInventory, dailyConsumption, delayDays) {
  const daysOfStock = calculateDaysOfStock(currentInventory, dailyConsumption);
  const today = new Date();
  let quantityAtRisk = 0;
  let ordersAtRisk   = 0;
  const riskOrders   = [];

  for (const order of productionOrders) {
    if (!order.dueDate) continue;
    const due         = new Date(order.dueDate);
    const daysUntilDue = Math.ceil((due - today) / 86400000);
    const isAtRisk    = daysUntilDue <= safe(delayDays) || daysUntilDue <= daysOfStock || order.status === 'AtRisk';
    if (isAtRisk) {
      quantityAtRisk += safe(order.requiredQuantity);
      ordersAtRisk++;
      riskOrders.push({
        orderNumber:      order.orderNumber,
        requiredQuantity: safe(order.requiredQuantity),
        dueDate:          order.dueDate,
        daysUntilDue,
        riskReason:       daysUntilDue <= safe(delayDays)
          ? 'Due within disruption window'
          : 'Due within stock-out period'
      });
    }
  }

  const totalRequired = productionOrders.reduce((s, o) => s + safe(o.requiredQuantity), 0);
  const riskPercent   = safeDivide(quantityAtRisk, totalRequired, 0) * 100;

  let riskLevel = 'Low';
  if (riskPercent > 70)      riskLevel = 'Critical';
  else if (riskPercent > 40) riskLevel = 'High';
  else if (riskPercent > 15) riskLevel = 'Medium';

  return {
    totalProductionOrders: productionOrders.length,
    ordersAtRisk,
    quantityAtRisk:  Math.round(quantityAtRisk),
    totalRequired:   Math.round(totalRequired),
    riskPercent:     Math.round(riskPercent * 10) / 10,
    riskLevel,
    riskOrders
  };
}

// ── Sister Plant Safety ───────────────────────────────────────────────────

export async function validateSisterPlantTransfer(db, sourcePlantId, shortageQuantity, delayDays) {
  const [sourcePlant] = await db.read('hackfest.db.Plants').where({ ID: sourcePlantId });
  if (!sourcePlant) return { feasible: false, reason: 'Source plant not found', transferableQuantity: 0 };

  const sourceInventory   = await db.read('hackfest.db.Inventory').where({ 'plant_ID': sourcePlantId });
  const totalSourceStock  = sourceInventory.reduce((s, i) => s + safe(i.quantity), 0);
  const sourceDailyDemand = safe(sourcePlant.dailyDemand) || 50;
  const safetyThreshold   = safe(sourcePlant.safetyStockDays) || 3;
  const safetyRequired    = sourceDailyDemand * (safe(delayDays) + safetyThreshold);
  const transferableQty   = Math.max(0, Math.floor(totalSourceStock - safetyRequired));

  if (transferableQty <= 0) {
    return {
      feasible: false,
      reason: `Transfer rejected: source plant safety threshold would be violated. Source has ${Math.round(totalSourceStock)} units but needs ${Math.round(safetyRequired)} for safety stock.`,
      transferableQuantity: 0, sourcePlant,
      totalSourceStock: Math.round(totalSourceStock),
      safetyRequired: Math.round(safetyRequired), sourceSafe: false
    };
  }

  const effectiveTransfer     = Math.min(transferableQty, safe(shortageQuantity));
  const remainingAfterTransfer = totalSourceStock - effectiveTransfer;

  return {
    feasible: true,
    reason: 'Transfer feasible — source plant remains operationally safe',
    transferableQuantity: Math.round(transferableQty),
    effectiveTransfer:    Math.round(effectiveTransfer),
    remainingAfterTransfer: Math.round(remainingAfterTransfer),
    safetyRequired:       Math.round(safetyRequired),
    totalSourceStock:     Math.round(totalSourceStock),
    sourcePlant, sourceSafe: true
  };
}

// ── Recovery Quantity ─────────────────────────────────────────────────────

export function calculateRecoveryQuantity(availableQuantity, shortageQuantity) {
  const avail  = safe(availableQuantity);
  const needed = safe(shortageQuantity);
  return {
    requested:    Math.round(needed),
    available:    Math.round(avail),
    allocated:    Math.round(Math.min(avail, needed)),
    shortfall:    Math.round(Math.max(needed - avail, 0)),
    fullyCovers:  avail >= needed
  };
}

export function calculateTransitTime(distanceKm, transportMode) {
  const km = safe(distanceKm);
  const speeds = { Road: 400, Rail: 600, Air: 3000, Sea: 800, Multimodal: 450 };
  const speed  = speeds[transportMode] || 400;
  return Math.max(1, Math.ceil(safeDivide(km, speed, 1)));
}

// ── Cost Engine ───────────────────────────────────────────────────────────

export function calculateRecoveryCost(options) {
  const { strategy, quantity, unitCost, distanceKm, transportMode, isExpedited, sourcePlantTransferCost } = options;
  const qty      = safe(quantity);
  const cost     = safe(unitCost);
  const distance = safe(distanceKm);

  let transportCost = 0, supplierPremium = 0, expediteCost = 0, transferCost = 0, materialCost = 0;

  if (strategy === 'SisterPlantTransfer') {
    transportCost = Math.round(distance * 0.85 + qty * 1.2);
    transferCost  = safe(sourcePlantTransferCost) || Math.round(qty * 8);
  } else if (strategy === 'AlternateSupplier') {
    materialCost    = Math.round(qty * cost);
    transportCost   = Math.round(distance * 0.9 + qty * 1.5);
    supplierPremium = Math.round(materialCost * 0.08);
    if (isExpedited) expediteCost = Math.round(materialCost * 0.12);
  } else if (strategy === 'Combination') {
    materialCost    = Math.round(qty * cost * 0.5);
    transportCost   = Math.round(distance * 0.87 + qty * 1.3);
    supplierPremium = Math.round(materialCost * 0.06);
    transferCost    = Math.round(qty * 0.5 * 7);
  } else {
    materialCost  = Math.round(qty * cost * 1.3);
    transportCost = Math.round(qty * 12);
    expediteCost  = Math.round(materialCost * 0.20);
  }

  const total = materialCost + transportCost + supplierPremium + expediteCost + transferCost;
  return {
    materialCost, transportCost, supplierPremium, expediteCost, transferCost,
    totalCost: total, currency: 'USD',
    breakdown: { material: materialCost, transport: transportCost, premium: supplierPremium, expedite: expediteCost, transfer: transferCost }
  };
}

// ── Risk Engine ───────────────────────────────────────────────────────────

export function calculateRisk(options) {
  const { strategy, shortageQuantity, allocatedQuantity, recoveryDays, delayDays, sourcePlantSafe, supplierRiskStatus, daysOfStock, transitDays } = options;
  const factors = [];
  let score = 0;

  // Inventory risk
  const doss    = safe(daysOfStock);
  const invRisk = doss < 2 ? 'Critical' : doss < 5 ? 'High' : doss < 10 ? 'Medium' : 'Low';
  score += { Critical: 30, High: 20, Medium: 10, Low: 2 }[invRisk];
  factors.push({ factor: 'Inventory', level: invRisk, description: `${Math.round(doss)} days of stock remaining` });

  // Coverage risk
  const coverageRatio = safeDivide(safe(allocatedQuantity), safe(shortageQuantity), 0);
  const covRisk       = coverageRatio < 0.5 ? 'High' : coverageRatio < 0.8 ? 'Medium' : 'Low';
  score += { High: 20, Medium: 10, Low: 2 }[covRisk];
  factors.push({ factor: 'Coverage', level: covRisk, description: `${Math.round(coverageRatio * 100)}% of shortage covered` });

  // Recovery time risk
  const totalTime = safe(recoveryDays) + safe(transitDays);
  const timeVsDelay = safe(delayDays);
  const timeRisk  = totalTime > timeVsDelay * 2 ? 'High' : totalTime > timeVsDelay ? 'Medium' : 'Low';
  score += { High: 20, Medium: 10, Low: 2 }[timeRisk];
  factors.push({ factor: 'Recovery Time', level: timeRisk, description: `${totalTime} days total vs ${timeVsDelay} day disruption` });

  if (strategy === 'SisterPlantTransfer' || strategy === 'Combination') {
    const srcRisk = sourcePlantSafe ? 'Low' : 'Critical';
    score += { Critical: 25, Low: 2 }[srcRisk];
    factors.push({ factor: 'Source Plant Safety', level: srcRisk, description: sourcePlantSafe ? 'Source plant remains operational' : 'Source plant would be at risk' });
  }

  if (strategy === 'AlternateSupplier' || strategy === 'Combination') {
    const supRisk = supplierRiskStatus === 'High' || supplierRiskStatus === 'Critical' ? 'High' : supplierRiskStatus === 'Medium' ? 'Medium' : 'Low';
    score += { High: 15, Medium: 8, Low: 2 }[supRisk];
    factors.push({ factor: 'Supplier Risk', level: supRisk, description: `Alternate supplier risk: ${supplierRiskStatus}` });
  }

  const tdays      = safe(transitDays);
  const transitRisk = tdays > 7 ? 'High' : tdays > 3 ? 'Medium' : 'Low';
  score += { High: 10, Medium: 5, Low: 1 }[transitRisk];
  factors.push({ factor: 'Transit', level: transitRisk, description: `${tdays} day transit time` });

  const finalScore = Math.min(Math.round(score), 100);
  const level      = finalScore >= 70 ? 'Critical' : finalScore >= 45 ? 'High' : finalScore >= 20 ? 'Medium' : 'Low';

  return {
    riskScore: finalScore, riskLevel: level, riskFactors: factors,
    inventoryRisk: invRisk, coverageRisk: covRisk, recoveryTimeRisk: timeRisk,
    transitRisk, sourcePlantRisk: sourcePlantSafe === false ? 'Critical' : 'Low',
    supplierRisk: supplierRiskStatus || 'N/A'
  };
}

// ── Compare ───────────────────────────────────────────────────────────────

export function compareRecoveryOptions(plans) {
  if (!plans || plans.length === 0) return { recommended: null, analysis: [] };
  const scored = plans.map(p => ({
    ...p,
    compositeScore: (safe(p.riskScore) * 0.35) +
      (safeDivide(safe(p.estimatedCost), 100000, 0) * 0.30) +
      (safeDivide(safe(p.estimatedRecoveryDays), 30, 0) * 0.20) +
      ((p.sourcePlantSafe === false ? 30 : 0) * 0.15)
  }));
  scored.sort((a, b) => a.compositeScore - b.compositeScore);
  return { recommended: scored[0], analysis: scored };
}

// ── Triage pipeline ───────────────────────────────────────────────────────

export async function runTriage(db, disruption) {
  const inv   = await getAffectedInventory(db, disruption.material_ID || disruption.material?.ID);
  const plant = disruption.affectedPlant_ID
    ? await db.read('hackfest.db.Plants').where({ ID: disruption.affectedPlant_ID }).then(r => r[0] || null)
    : disruption.affectedPlant || null;
  const orders = await getAffectedProductionOrders(
    db, disruption.material_ID || disruption.material?.ID,
    disruption.affectedPlant_ID || disruption.affectedPlant?.ID
  );

  const dailyConsumption = calculateDailyConsumption(inv);
  const currentInventory = safe(inv?.quantity);
  const delayDays        = safe(disruption.estimatedDelayDays);
  const stockoutInfo     = calculateStockout(currentInventory, dailyConsumption, delayDays);
  const productionRisk   = calculateProductionRisk(orders, currentInventory, dailyConsumption, delayDays);

  let urgency = 'Low';
  if (disruption.severity === 'Critical' || stockoutInfo.stockoutDuringDisruption) urgency = 'Critical';
  else if (disruption.severity === 'High' || productionRisk.riskLevel === 'High') urgency = 'High';
  else if (disruption.severity === 'Medium' || productionRisk.riskLevel === 'Medium') urgency = 'Medium';

  return {
    disruption: { ID: disruption.ID, type: disruption.type, severity: disruption.severity, status: disruption.status, estimatedDelayDays: delayDays, description: disruption.description },
    supplier: disruption.supplier || null,
    material: inv ? { ID: inv.ID, code: inv.materialCode, name: inv.materialName, unitCost: inv.unitCost } : null,
    plant: plant ? { ID: plant.ID, name: plant.name, location: plant.location, operatingStatus: plant.operatingStatus } : null,
    inventory: { current: currentInventory, reorderLevel: safe(inv?.reorderLevel), safetyStock: safe(inv?.safetyStock), dailyConsumption, daysOfStock: stockoutInfo.daysOfStock, belowReorder: currentInventory < safe(inv?.reorderLevel) },
    stockout: stockoutInfo, productionRisk,
    productionOrders: orders.map(o => ({ orderNumber: o.orderNumber, requiredQuantity: safe(o.requiredQuantity), dueDate: o.dueDate, status: o.status })),
    urgency,
    recommendedAction: urgency === 'Critical' ? 'Immediate escalation and emergency recovery required'
      : urgency === 'High' ? 'Expedited recovery planning required within 24 hours'
      : urgency === 'Medium' ? 'Recovery planning required within 48 hours'
      : 'Monitor and plan proactively'
  };
}

// ── Impact pipeline ───────────────────────────────────────────────────────

export async function runImpactAnalysis(db, disruption) {
  const inv    = await getAffectedInventory(db, disruption.material_ID || disruption.material?.ID);
  const plant  = disruption.affectedPlant_ID
    ? await db.read('hackfest.db.Plants').where({ ID: disruption.affectedPlant_ID }).then(r => r[0] || null)
    : disruption.affectedPlant || null;
  const orders = await getAffectedProductionOrders(
    db, disruption.material_ID || disruption.material?.ID,
    disruption.affectedPlant_ID || disruption.affectedPlant?.ID
  );

  const currentInventory  = safe(inv?.quantity);
  const reorderLevel      = safe(inv?.reorderLevel);
  const safetyStock       = safe(inv?.safetyStock);
  const dailyConsumption  = calculateDailyConsumption(inv);
  const delayDays         = safe(disruption.estimatedDelayDays);
  const totalRequired     = orders.reduce((s, o) => s + safe(o.requiredQuantity), 0);
  const shortageQuantity  = calculateShortage(totalRequired, currentInventory);
  const stockoutInfo      = calculateStockout(currentInventory, dailyConsumption, delayDays);
  const productionRisk    = calculateProductionRisk(orders, currentInventory, dailyConsumption, delayDays);
  const unitCost          = safe(inv?.unitCost) || 100;
  const financialEstimate = Math.round(shortageQuantity * unitCost);

  let estimatedStockoutDate = null;
  if (dailyConsumption > 0) {
    const d = new Date();
    d.setDate(d.getDate() + Math.floor(currentInventory / dailyConsumption));
    estimatedStockoutDate = d.toISOString().split('T')[0];
  }

  return {
    currentInventory, reorderLevel, safetyStock,
    dailyConsumption: Math.round(dailyConsumption * 10) / 10,
    daysOfStock: stockoutInfo.daysOfStock,
    estimatedStockoutDate,
    shortageQuantity:        Math.round(shortageQuantity),
    requiredQuantity:        Math.round(totalRequired),
    availableQuantity:       currentInventory,
    stockoutDuringDisruption: stockoutInfo.stockoutDuringDisruption,
    criticalGapDays:         stockoutInfo.criticalGapDays,
    affectedProductionOrders: orders.length,
    productionQuantityAtRisk: productionRisk.quantityAtRisk,
    productionRisk, financialEstimate, currency: 'USD',
    belowReorder: currentInventory < reorderLevel,
    belowSafety:  currentInventory < safetyStock,
    plant: plant || null,
    material: inv || null
  };
}
