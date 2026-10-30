THAN TAI MAY MAN - BONGDALU MIGRATION WORKING BUILD
Build date: 2026-10-31

Implemented in this build:
1. New LIVE fixture discovery uses Bongdalu proxy only:
   /wp-json/wpsport/v1/proxy?path=/v1/football/match/live?lang=vn&locale=vi
   IDs are retained as Bongdalu native ScheduleID/RapidEventID/match_id; no API-Sports cross-linking is performed.
2. New LIVE Odds polling uses the observed endpoint:
   /v1/football/odds/live?companyid=22&locale=vi
   Raw HDP/OU/1x2 rows are retained per Bongdalu match_id, and changed snapshots are held in memory for 1/3/5/10-minute comparisons.
3. Main scan cadence changed to 5 seconds; eligible LIVE analysis window changed to minutes 60-88.
4. AI THU NGHIEM Telegram sender is disabled while its observation/comparison code remains present.
5. API-Sports key is disabled in this build; its previous LIVE discovery path is not used.
6. The 30-second AI priority refresh now re-reads Bongdalu LIVE rather than API-Sports/Flashscore.

IMPORTANT - NOT YET VERIFIED / NOT COMPLETE:
- The screenshots show the Odds response schema and the Odds URL, but do not show the full match-LIVE request URL. The match endpoint path is reused from the LỘC PHÁT adapter and needs a live deployment check.
- Odds are captured and stored as raw Bongdalu records; they are not yet translated into the legacy API-Sports Odds payload shape consumed by every existing Odds gate/UI. Multi-bookmaker polling requires BONGDALU_COMPANY_IDS to contain the provider company IDs; default is 22 only.
- FT settlement/reconciliation across all existing audit stores has not been fully migrated to Bongdalu diary records.
- Goal timeline / live incident retrieval has not been fully migrated. Do not treat current-score changes as a verified event timeline.
- The existing AI LIVE decision and Telegram behavior have not been end-to-end tested against live Bongdalu data.
- In-memory odds history resets on process restart and is not a durable historical store.
- No live network test was possible in this build environment.

Environment:
- BONGDALU_BASE_URL (optional, default https://g4mlw.net)
- BONGDALU_COMPANY_IDS (comma-separated Bongdalu company IDs; default 22)

This is a working migration build for code review/integration testing, NOT a production-complete release.
