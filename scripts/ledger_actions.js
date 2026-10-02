/**
 * ledger_actions.js — the ledger action vocabulary, shared by build.js and
 * scripts/validate_ledger.js. template.html carries the same definitions
 * (isFillRow, isBuyRow, isSellRow, rowQtyDelta, rowFlowLoc) because the
 * browser cannot require this module; keep the two in step.
 *
 * B and S are fills: they move quantity and cash. Every consumer reads a
 * row's effect through these helpers rather than testing `a` inline, because
 * the inline form `t.a === 'B' ? +1 : -1` reads any other action code as a
 * sell. A code outside the vocabulary throws, and checkActions() lets the
 * gates refuse such a row before a bake can publish it. Before 2026-10-02
 * every gate filtered unknown codes out silently, so a mistyped action was
 * dropped from the book without a word.
 */
const FILL_ACTIONS = new Set(['B', 'S']);

function isFillRow(t) { return FILL_ACTIONS.has(t.a); }

function ledgerAction(t) {
  if (!FILL_ACTIONS.has(t.a)) throw new Error(`ledger row ${t.d} ${t.t}: unknown action ${JSON.stringify(t.a)}`);
  return t.a;
}
function isBuyRow(t) { return ledgerAction(t) === 'B'; }
function isSellRow(t) { return ledgerAction(t) === 'S'; }

// Signed change in quantity held: +q on a buy, -q on a sell.
function rowQtyDelta(t) { return isBuyRow(t) ? t.q : -t.q; }

// Signed capital deployed into the position, native currency, before fees:
// +q×p on a buy, -q×p on a sell. The cash bucket moves by the negative.
function rowFlowLoc(t) { return isBuyRow(t) ? t.q * t.p : -(t.q * t.p); }

// One message per row whose action code is outside the vocabulary.
function checkActions(trades) {
  return trades.filter(t => !FILL_ACTIONS.has(t.a))
    .map(t => `${t.d} ${t.t}: unknown action ${JSON.stringify(t.a)} (vocabulary: ${[...FILL_ACTIONS].join(', ')})`);
}

module.exports = { FILL_ACTIONS, isFillRow, isBuyRow, isSellRow, rowQtyDelta, rowFlowLoc, checkActions };
