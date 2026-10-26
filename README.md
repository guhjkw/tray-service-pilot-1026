# Tray service pilot (relational operations database demo)

A live, working demo built for an Upwork job post: a pilot operations database for an insect-rearing operation, starting with one procedure, W1410 Routine Tray Service, and a data model that keeps population identity when containers are split and consolidated.

It is a real tool, not a video. **Everything here is invented:** Northfield Rearing Lab, its containers, populations, operators and measurements. No real data.

## Try it

Open `index.html` (works straight off disk) or the live link, then:

- **Scan next due tray**: the container ID brings up the population, species, stage, age and last service. Enter tray mass, water and feed, tick observations, save.
- Try to break it: an empty tray (110), an unknown one (9999), 50 g, "too wet" and "too dry" together, the same tray twice today.
- **Split** C-0104 into empty trays: the population ID stays the same everywhere.
- **Consolidate** C-0103 with C-0109: a new population appears whose lineage goes back to four ancestors.
- Filter the service history (optionally including parent populations) and **Export CSV**.

## Files

```
tray-service-pilot-1026/
├── index.html              the page (built from index.src.html with the data embedded)
├── index.src.html          page source
├── build.py                embeds data/facility.json into index.html for the file:// case
├── src/colonyEngine.js     ALL the logic, one file, loaded by the page AND the tests
├── data/facility.json      invented facility: 15 trays, 7 populations, 16 transactions
├── tests/verify.js         53 engine checks (node)
├── tests/test-output.txt   the saved passing run
├── tests/browser-check.py  22 Playwright checks driving the real page
└── README.md
```

## Run the tests

```
node tests/verify.js            # 53 checks: 53 passed, 0 failed
python3 tests/browser-check.py  # 22 browser checks: 22 passed, 0 failed (needs: pip install playwright && playwright install chromium)
```

## The data model

| Table | Holds | Rule |
|---|---|---|
| populations | PID, species, lifecycle stage, origin (hatched or merged), status | Never deleted; closed when nothing of it remains |
| containers | CID (the barcode), rack, shelf | Physical trays |
| assignments | CID, PID, from, to | One open row per container; one population can be in many containers |
| lineage | child PID, parent PID, share, transaction | Written when different populations are consolidated |
| transactions | W1410 services, splits, consolidations, stage changes | Append-only, with operator and time |

A split adds assignment rows under the same PID. Consolidating trays of the same PID closes the emptied assignment. Consolidating different populations (same species and stage only) creates a new PID with lineage rows weighted by each tray's latest mass.

## W1410 validation

Tray mass 200 to 6000 g, water 0 to 400 mL, feed 0 to 800 g, a known operator, known observations, notes under 500 characters, one service per tray per day, no service on an empty tray. A mass change over 25% since the last service, or mold, mites or high mortality, saves the record as **Needs review**.

## What the delivered version adds

The pilot is delivered on the agreed platform (recommended: AppSheet screens on a relational database such as AppSheet Database or Cloud SQL PostgreSQL), with these same rules enforced in the database and the app, real barcode scanning once labels exist, and every editable component handed over.

Built by Taiwo, Pathfinder Automation Solutions.
