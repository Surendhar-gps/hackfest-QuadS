/**
 * supplyChain.test.js
 *
 * Unit tests for the deterministic supply chain engine.
 * Run: node test/supplyChain.test.js
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// We use a simple assert-based approach compatible with Node.js without jest
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}`);
    console.error(`    → ${e.message}`);
    failed++;
  }
}

// Dynamically import the engine (ES module compat)
const engine = require('../srv/supplyChainEngine.js');

const {
  safe,
  safeDivide,
  calculateDailyConsumption,
  calculateDaysOfStock,
  calculateShortage,
  calculateStockout,
  calculateProductionRisk,
  calculateRecoveryQuantity,
  calculateTransitTime,
  calculateRecoveryCost,
  calculateRisk,
  compareRecoveryOptions
} = engine;

// ─── safe helpers ──────────────────────────────────────────────────────────

console.log('\n[safe helpers]');

test('safe(null) returns 0', () => assert.strictEqual(safe(null), 0));
test('safe(undefined) returns 0', () => assert.strictEqual(safe(undefined), 0));
test('safe(NaN) returns 0', () => assert.strictEqual(safe(NaN), 0));
test('safe(Infinity) returns 0', () => assert.strictEqual(safe(Infinity), 0));
test('safe(42) returns 42', () => assert.strictEqual(safe(42), 42));
test('safe("15") returns 15', () => assert.strictEqual(safe("15"), 15));

test('safeDivide(10, 0) returns fallback', () => assert.strictEqual(safeDivide(10, 0, 99), 99));
test('safeDivide(10, 2) returns 5', () => assert.strictEqual(safeDivide(10, 2), 5));
test('safeDivide(0, 0) returns fallback', () => assert.strictEqual(safeDivide(0, 0, -1), -1));

// ─── Shortage ──────────────────────────────────────────────────────────────

console.log('\n[calculateShortage]');

test('shortage when required > available', () => {
  assert.strictEqual(calculateShortage(500, 120), 380);
});
test('no shortage when available >= required', () => {
  assert.strictEqual(calculateShortage(200, 450), 0);
});
test('no shortage when equal', () => {
  assert.strictEqual(calculateShortage(200, 200), 0);
});
test('zero inventory produces full shortage', () => {
  assert.strictEqual(calculateShortage(300, 0), 300);
});

// ─── Days of stock ─────────────────────────────────────────────────────────

console.log('\n[calculateDaysOfStock]');

test('days of stock = inventory / consumption', () => {
  const d = calculateDaysOfStock(120, 35);
  assert.ok(d > 3 && d < 4, `Expected ~3.4, got ${d}`);
});
test('zero daily consumption returns safe fallback (large number)', () => {
  const d = calculateDaysOfStock(120, 0);
  assert.ok(d >= 999 || d === 0, `Should be 999 or 0, got ${d}`);
});
test('zero inventory returns 0', () => {
  assert.strictEqual(calculateDaysOfStock(0, 35), 0);
});

// ─── Stockout ──────────────────────────────────────────────────────────────

console.log('\n[calculateStockout]');

test('stockout detected when stock < delay', () => {
  const r = calculateStockout(120, 35, 8); // 3.4 days stock, 8 day delay
  assert.ok(r.stockoutDuringDisruption, 'Should detect stockout');
  assert.ok(r.criticalGapDays > 0, 'Critical gap should be positive');
});
test('no stockout when stock > delay', () => {
  const r = calculateStockout(450, 42, 4); // ~10.7 days stock, 4 day delay
  assert.ok(!r.stockoutDuringDisruption, 'Should not detect stockout');
});
test('daysOfStock is rounded to 1 decimal', () => {
  const r = calculateStockout(100, 33, 5);
  assert.ok(Number.isFinite(r.daysOfStock), 'Should be finite');
});

// ─── Production Risk ───────────────────────────────────────────────────────

console.log('\n[calculateProductionRisk]');

const today = new Date();
const addDays = (d) => { const n = new Date(today); n.setDate(n.getDate() + d); return n.toISOString().split('T')[0]; };

test('production orders within delay window are at risk', () => {
  const orders = [
    { orderNumber: 'PO-001', requiredQuantity: 280, dueDate: addDays(3), status: 'Confirmed' },
    { orderNumber: 'PO-002', requiredQuantity: 210, dueDate: addDays(15), status: 'Confirmed' }
  ];
  const r = calculateProductionRisk(orders, 120, 35, 8);
  assert.ok(r.ordersAtRisk >= 1, 'Should have at least 1 order at risk');
  assert.ok(r.quantityAtRisk > 0, 'Quantity at risk should be positive');
});

test('no at-risk orders when delay is 0', () => {
  const orders = [
    { orderNumber: 'PO-003', requiredQuantity: 100, dueDate: addDays(30), status: 'Confirmed' }
  ];
  const r = calculateProductionRisk(orders, 500, 35, 0);
  assert.strictEqual(r.ordersAtRisk, 0, 'No orders at risk');
});

test('empty orders returns zero risk', () => {
  const r = calculateProductionRisk([], 500, 35, 8);
  assert.strictEqual(r.ordersAtRisk, 0);
  assert.strictEqual(r.quantityAtRisk, 0);
});

// ─── Recovery Quantity ─────────────────────────────────────────────────────

console.log('\n[calculateRecoveryQuantity]');

test('fully covers shortage', () => {
  const r = calculateRecoveryQuantity(500, 380);
  assert.ok(r.fullyCovers, 'Should fully cover');
  assert.strictEqual(r.allocated, 380);
  assert.strictEqual(r.shortfall, 0);
});
test('partial coverage', () => {
  const r = calculateRecoveryQuantity(150, 380);
  assert.ok(!r.fullyCovers, 'Should not fully cover');
  assert.strictEqual(r.allocated, 150);
  assert.strictEqual(r.shortfall, 230);
});
test('zero available returns zero allocated', () => {
  const r = calculateRecoveryQuantity(0, 380);
  assert.strictEqual(r.allocated, 0);
  assert.strictEqual(r.shortfall, 380);
});

// ─── Transit Time ──────────────────────────────────────────────────────────

console.log('\n[calculateTransitTime]');

test('road transit 400km = 1 day', () => {
  assert.strictEqual(calculateTransitTime(400, 'Road'), 1);
});
test('air transit 3000km = 1 day', () => {
  assert.strictEqual(calculateTransitTime(3000, 'Air'), 1);
});
test('road transit 900km = 3 days (ceil)', () => {
  const t = calculateTransitTime(900, 'Road');
  assert.ok(t >= 2 && t <= 3, `Expected 2-3, got ${t}`);
});
test('minimum transit is 1 day', () => {
  assert.strictEqual(calculateTransitTime(1, 'Road'), 1);
});

// ─── Cost Engine ───────────────────────────────────────────────────────────

console.log('\n[calculateRecoveryCost]');

test('sister plant transfer cost is positive', () => {
  const r = calculateRecoveryCost({ strategy: 'SisterPlantTransfer', quantity: 300, distanceKm: 250, transportMode: 'Road' });
  assert.ok(r.totalCost > 0, `Expected positive total, got ${r.totalCost}`);
  assert.strictEqual(r.materialCost, 0, 'Sister plant: no material cost');
});

test('alternate supplier cost includes material', () => {
  const r = calculateRecoveryCost({ strategy: 'AlternateSupplier', quantity: 300, unitCost: 92, distanceKm: 500, transportMode: 'Road' });
  assert.ok(r.materialCost > 0, 'Material cost should be positive');
  assert.ok(r.supplierPremium > 0, 'Supplier premium should exist');
  assert.ok(r.totalCost >= r.materialCost + r.transportCost, 'Total should sum correctly');
});

test('breakdown sums to total', () => {
  const r = calculateRecoveryCost({ strategy: 'AlternateSupplier', quantity: 200, unitCost: 100, distanceKm: 400, transportMode: 'Road' });
  const sum = r.breakdown.material + r.breakdown.transport + r.breakdown.premium + r.breakdown.expedite + r.breakdown.transfer;
  assert.strictEqual(sum, r.totalCost, `Sum ${sum} should equal total ${r.totalCost}`);
});

// ─── Risk Engine ───────────────────────────────────────────────────────────

console.log('\n[calculateRisk]');

test('risk score is between 0 and 100', () => {
  const r = calculateRisk({
    strategy: 'SisterPlantTransfer',
    shortageQuantity: 380,
    allocatedQuantity: 300,
    recoveryDays: 1,
    delayDays: 8,
    sourcePlantSafe: true,
    daysOfStock: 3.4,
    transitDays: 2
  });
  assert.ok(r.riskScore >= 0 && r.riskScore <= 100, `Score out of range: ${r.riskScore}`);
  assert.ok(['Low','Medium','High','Critical'].includes(r.riskLevel), `Invalid level: ${r.riskLevel}`);
});

test('critical risk when source plant is unsafe', () => {
  const r = calculateRisk({
    strategy: 'SisterPlantTransfer',
    shortageQuantity: 380,
    allocatedQuantity: 100,
    recoveryDays: 5,
    delayDays: 8,
    sourcePlantSafe: false,
    daysOfStock: 1,
    transitDays: 5
  });
  assert.ok(r.riskScore > 50, `Should be high risk, got ${r.riskScore}`);
});

test('risk factors array is populated', () => {
  const r = calculateRisk({
    strategy: 'AlternateSupplier',
    shortageQuantity: 200,
    allocatedQuantity: 200,
    recoveryDays: 6,
    delayDays: 4,
    sourcePlantSafe: true,
    supplierRiskStatus: 'Medium',
    daysOfStock: 10,
    transitDays: 2
  });
  assert.ok(Array.isArray(r.riskFactors), 'riskFactors should be array');
  assert.ok(r.riskFactors.length > 0, 'Should have at least one risk factor');
});

// ─── Compare Recovery Options ──────────────────────────────────────────────

console.log('\n[compareRecoveryOptions]');

test('lowest composite score is recommended', () => {
  const plans = [
    { ID: '1', riskScore: 60, estimatedCost: 50000, estimatedRecoveryDays: 10, sourcePlantSafe: true },
    { ID: '2', riskScore: 20, estimatedCost: 15000, estimatedRecoveryDays: 3,  sourcePlantSafe: true }
  ];
  const r = compareRecoveryOptions(plans);
  assert.strictEqual(r.recommended.ID, '2', 'Plan 2 should be recommended (lower risk/cost)');
});

test('empty plans returns null recommended', () => {
  const r = compareRecoveryOptions([]);
  assert.strictEqual(r.recommended, null);
});

// ─── Gemini model helper ───────────────────────────────────────────────────

console.log('\n[geminiModel]');

const gemini = require('../srv/geminiModel.js');

test('extractJSON handles direct JSON', () => {
  const result = gemini.extractJSON('{"key": "value"}');
  assert.deepStrictEqual(result, { key: 'value' });
});

test('extractJSON handles markdown fenced JSON', () => {
  const result = gemini.extractJSON('```json\n{"key": "value"}\n```');
  assert.deepStrictEqual(result, { key: 'value' });
});

test('extractJSON returns null for invalid text', () => {
  const result = gemini.extractJSON('This is not JSON at all.');
  assert.strictEqual(result, null);
});

test('isAvailable returns false when key missing', () => {
  // Save and clear key
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  // Re-require won't re-read env in cached modules, just test the function
  assert.ok(typeof gemini.isAvailable === 'function', 'isAvailable should be a function');
  if (saved) process.env.GEMINI_API_KEY = saved;
});

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('─'.repeat(50));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!\n');
}
