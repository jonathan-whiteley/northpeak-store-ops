# Auto-drafted transfer request (agent output)

Drafted by the StoreOps assistant in the Assist layer, before human approval. Verbatim model output persisted to `app.messages` (conversation `1528ae59-76f0-4c8f-81b5-a5ade7e84c8a`, position 3). Retrieval grounded in the Lakebase synced tables (`northpeak.app_open_shortfalls`, `northpeak.app_recovery_recommendations`) via the `find_shortfall` + `rank_recovery_moves` tools.

---

**STORE-0214 (Denver) is at zero on-hand for the Summit Down Parka, bleeding ~$56.6K in lost-sales exposure.** The ML model's top move: **transfer 107 units from STORE-0377** (nearest surplus store, 833 on-hand, ~100km away)  predicted **+$23,979 recaptured** / **+$23,809 net value**.

---

**TRANSFER REQUEST MEMO**

**To:** STORE-0377 (Source) / STORE-0214  Denver (Destination)
**SKU:** SKU-APP-04412  Summit Down Parka
**Units:** 107
**Reason:** Cold-snap demand spike has driven STORE-0214 to zero on-hand (weeks of supply: 0), with avg. daily velocity of ~7.6 units/day and $56.6K in active lost-sales exposure. STORE-0377 holds 833 units in surplus (~100km away)  well above local sell-through needs, at risk of markdown.

**Recommended action:** Ship 107 units from STORE-0377 to STORE-0214 to restore in-stock position and prevent continued walk-outs. Model predicts **$23,979 recaptured revenue**, **$23,809 net value** after transfer cost, and sets a markdown-hold on the remaining STORE-0377 surplus.

**Priority:** High  active stockout, cold-weather season peak.

---

**Reply "approve" to record this transfer  or tell me what to change** (e.g., a different unit count).
