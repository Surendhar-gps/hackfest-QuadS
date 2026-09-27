/**
 * geminiModel.js — ES Module version
 *
 * Reusable Gemini API client.
 * API key server-side only via GEMINI_API_KEY env var.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT_MS || '25000', 10);

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ─── Safe JSON extraction ─────────────────────────────────────────────────

export function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (_) {}
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {} }
  const objMatch = text.match(/(\{[\s\S]*\})/);
  if (objMatch) { try { return JSON.parse(objMatch[1]); } catch (_) {} }
  return null;
}

// ─── Gemini call ──────────────────────────────────────────────────────────

export async function callGemini(prompt, { temperature = 0.3, maxTokens = 2048 } = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT);

  let response;
  try {
    response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body, signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Gemini request timed out after ${GEMINI_TIMEOUT}ms`);
    throw new Error(`Gemini network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── Structured explanation ───────────────────────────────────────────────

export async function generateExplanation(context) {
  const { disruption, triage, impact, recoveryOptions, routingOptions, costAnalysis, riskAnalysis } = context;

  const prompt = `You are an expert SAP Supply Chain Consultant providing an executive analysis for a manager.

CRITICAL INSTRUCTIONS:
- You are given AUTHORITATIVE, CALCULATED data from the deterministic supply chain engine.
- Do NOT invent any inventory levels, costs, quantities, dates, risk scores, or transit times.
- Do NOT override any calculated values.
- Your role is to EXPLAIN, SUMMARIZE, and COMPARE the provided data in clear, professional language.
- Return ONLY valid JSON matching the exact schema below.

=== DISRUPTION DATA (authoritative) ===
${JSON.stringify(disruption, null, 2)}

=== TRIAGE RESULT (authoritative) ===
${JSON.stringify(triage, null, 2)}

=== IMPACT ANALYSIS (authoritative) ===
${JSON.stringify(impact, null, 2)}

=== RECOVERY OPTIONS (authoritative) ===
${JSON.stringify(recoveryOptions, null, 2)}

=== ROUTING OPTIONS (authoritative) ===
${JSON.stringify(routingOptions, null, 2)}

=== COST ANALYSIS (authoritative) ===
${JSON.stringify(costAnalysis, null, 2)}

=== RISK ANALYSIS (authoritative) ===
${JSON.stringify(riskAnalysis, null, 2)}

Return ONLY a JSON object with these exact fields:
{
  "executiveSummary": "2-3 sentence executive summary of situation and recommended action",
  "situation": "Describe the disruption type, severity, and business context in 2-3 sentences",
  "impactExplanation": "Explain the calculated inventory, stockout and production impact in plain English",
  "recoveryExplanation": "Compare recovery options, highlight trade-offs between cost, time and risk using the provided numbers",
  "costExplanation": "Explain the cost breakdown and justify the total cost estimate",
  "riskExplanation": "Explain risk factors and overall risk level using the provided analysis",
  "assumptions": ["list of key assumptions"],
  "tradeoffs": "Key trade-offs between recovery options",
  "nextAction": "Specific actionable recommendation for the manager",
  "confidence": "high",
  "urgency": "Critical"
}`;

  let rawText;
  try {
    rawText = await callGemini(prompt, { temperature: 0.2, maxTokens: 2048 });
  } catch (err) {
    return { error: err.message, fallback: true };
  }

  const parsed = extractJSON(rawText);
  if (!parsed) {
    return { error: 'Gemini returned unstructured response', rawText: rawText.substring(0, 500), fallback: true };
  }

  const required = ['executiveSummary', 'situation', 'impactExplanation', 'recoveryExplanation', 'nextAction'];
  for (const field of required) {
    if (!parsed[field]) parsed[field] = '[AI field missing — deterministic data is authoritative]';
  }

  return { ...parsed, fallback: false };
}

export function isAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}
