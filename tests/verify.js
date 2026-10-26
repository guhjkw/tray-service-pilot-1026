// tests/verify.js: node tests for src/colonyEngine.js, the same file the page loads. Run: node tests/verify.js
const E = require('../src/colonyEngine.js');
const RAW = require('../data/facility.json');

let pass = 0, fail = 0;
function sec(t) { console.log('\n' + t); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function fresh(mut) { const d = JSON.parse(JSON.stringify(RAW)); if (mut) mut(d); return E.newState(E.prepare(d).data); }
const svc = (c, extra) => Object.assign({ container: c, operator: 'op2', mass: 1600, water: 120, feed: 230, obs: [] }, extra || {});

sec('1. Data check: bad rows are skipped and reported, never a crash');
{
  const p = E.prepare(RAW);
  ok('sample data loads with no problems', p.problems.length === 0, p.problems);
  const bad = JSON.parse(JSON.stringify(RAW));
  bad.containers.push({ id: 'X-1' });
  bad.populations.push({ id: 'P-26-099', species: 'ZZ', stage: 'Egg', created: '2026-10-01', status: 'Active' });
  bad.assignments.push({ container: 'C-0101', population: 'P-26-034', from: '2026-10-20', to: null });
  bad.lineage.push({ child: 'P-26-040', parent: 'P-26-040', share: 1 });
  bad.transactions.push({ id: 'T-0010', type: 'W1410', at: '2026-10-20 08:00' });
  delete bad.today;
  const q = E.prepare(bad);
  ok('a malformed container id is skipped and reported', q.problems.some(t => /Container row 16/.test(t)) && q.data.containers.length === 15);
  ok('a population of an unknown species is skipped', q.problems.some(t => /Population row 8/.test(t)) && q.data.populations.length === 7);
  ok('a second open assignment for the same container is refused', q.problems.some(t => /only one population at a time/.test(t)));
  ok('a population cannot be its own parent', q.problems.some(t => /Lineage row 3/.test(t)) && q.data.lineage.length === 2);
  ok('a duplicate transaction id is skipped', q.problems.some(t => /Transaction row/.test(t)));
  ok('a missing "today" falls back and says so', q.data.today === '2026-10-26 09:00' && q.problems.some(t => /today/.test(t)));
}

sec('2. Scanning a container pulls the population');
{
  const s = fresh();
  const l = E.lookup(s, '101');
  ok('"101" is read as C-0101 (typed or scanned)', l.ok && l.container.id === 'C-0101');
  ok('C-0101 holds P-26-031, yellow mealworm, mid larva, day 42', l.population.id === 'P-26-031' && l.species.name === 'Yellow mealworm' && l.stage === 'Mid larva' && l.ageDays === 42, l.ageDays);
  ok('it knows the same population is also in C-0102 and C-0103', l.sharedWith.join() === 'C-0102,C-0103');
  ok('it shows the last service (T-0018, 1560 g)', l.last.id === 'T-0018' && l.last.mass === 1560);
  ok('an empty container says so', E.lookup(s, 'C-0110').empty === true);
  ok('an unknown container is refused', !E.lookup(s, 'C-9999').ok);
  ok('the merged population shows its two parents', E.lookup(s, 'C-0109').parents.map(p => p.parent).join() === 'P-26-027,P-26-028');
}

sec('3. W1410 Routine Tray Service: validation and recording');
{
  const s = fresh();
  const r = E.recordService(s, svc('C-0101', { mass: 1620 }));
  ok('a normal service is recorded as T-0021 with status Recorded', r.ok && r.tx.id === 'T-0021' && r.tx.status === 'Recorded');
  ok('the record links container, population and operator', r.tx.container === 'C-0101' && r.tx.population === 'P-26-031' && r.tx.operator === 'op2');
  ok('the trace shows scan, lookup, validate, compare, record', r.trace.map(t => t.name).join() === 'Scan,Lookup,Validate,Compare,Record');
  ok('a second service on the same container today is refused', /already serviced today/.test(E.recordService(s, svc('C-0101')).problems.join()));
  ok('servicing an empty container is refused', /empty/.test(E.recordService(s, svc('C-0110')).problems.join()));
  const bad = E.recordService(s, svc('C-0102', { mass: 50, water: -5, feed: 900, operator: '' }));
  ok('out-of-range mass, water and feed and a missing operator are all refused with reasons', !bad.ok && bad.problems.length === 4, bad.problems);
  ok('blank mass is refused (not read as zero)', /Tray mass/.test(E.recordService(s, svc('C-0102', { mass: '' })).problems.join()));
  ok('too wet and too dry together is refused', /both too wet and too dry/.test(E.recordService(s, svc('C-0102', { obs: ['Too wet', 'Too dry'] })).problems.join()));
  ok('an unknown observation is refused', /Unknown observation/.test(E.recordService(s, svc('C-0102', { obs: ['Sparkles'] })).problems.join()));
  const big = E.recordService(s, svc('C-0102', { mass: 2000 }));
  ok('a 44% mass change is saved but marked Needs review', big.ok && big.tx.status === 'Needs review' && /44%/.test(big.warnings[0]), big.warnings);
  const mold = E.recordService(s, svc('C-0103', { mass: 1450, obs: ['Mold'] }));
  ok('mold is saved but marked Needs review', mold.ok && mold.tx.status === 'Needs review' && /Mold/.test(mold.warnings.join()));
  const dry = E.recordService(s, svc('C-0105', { mass: 2250, obs: ['Too dry'] }));
  ok('"too dry" alone is recorded normally', dry.ok && dry.tx.status === 'Recorded');
  ok('notes over 500 characters are refused', /Notes/.test(E.recordService(s, svc('C-0106', { notes: 'x'.repeat(501) })).problems.join()));
}

sec('4. Splitting: more containers, the same population ID');
{
  const s = fresh();
  const r = E.split(s, { from: 'C-0104', to: ['C-0110', 'C-0111'], operator: 'op1' });
  ok('C-0104 splits into C-0110 and C-0111', r.ok && r.population === 'P-26-034');
  ok('all three containers now hold P-26-034: identity kept', E.lineage(s, 'P-26-034').now.sort().join() === 'C-0104,C-0110,C-0111');
  ok('no new population was created', s.populations.length === 7);
  ok('the split is one transaction listing every container', r.tx.type === 'Split' && r.tx.containers.join() === 'C-0104,C-0110,C-0111');
  ok('splitting into an occupied container is refused', /already holds/.test(E.split(s, { from: 'C-0105', to: ['C-0101'], operator: 'op1' }).problems.join()));
  ok('splitting an empty container is refused', /nothing to split/.test(E.split(s, { from: 'C-0112', to: ['C-0203'], operator: 'op1' }).problems.join()));
  ok('listing a destination twice is refused', /listed twice/.test(E.split(s, { from: 'C-0105', to: ['C-0112', 'C-0112'], operator: 'op1' }).problems.join()));
}

sec('5. Consolidating: same population keeps its ID, different populations make a new one');
{
  const s = fresh();
  const same = E.merge(s, { containers: ['C-0102', 'C-0103'], into: 'C-0102', operator: 'op1' });
  ok('two trays of P-26-031 consolidate without a new ID', same.ok && same.created === false && same.population === 'P-26-031');
  ok('C-0103 is now empty and C-0102 still holds P-26-031', !E.lookup(s, 'C-0103').population && E.lookup(s, 'C-0102').population.id === 'P-26-031');
  const s2 = fresh();
  const diff = E.merge(s2, { containers: ['C-0103', 'C-0109'], into: 'C-0103', operator: 'op1' });
  ok('P-26-031 (C-0103) and P-26-040 (C-0109) make a new population P-26-045', diff.ok && diff.created && diff.population === 'P-26-045');
  const lg = E.lineage(s2, 'P-26-045');
  ok('its parents and shares come from the latest tray masses (35% and 65%)', lg.ancestors.map(a => a.id + ':' + a.share).join() === 'P-26-031:0.35,P-26-040:0.65', lg.ancestors);
  ok('the lineage goes all the way back to P-26-027 and P-26-028', lg.ancestorIds.join() === 'P-26-031,P-26-040,P-26-027,P-26-028');
  ok('P-26-040 is closed (none of it is left anywhere)', s2.populations.find(p => p.id === 'P-26-040').status === 'Closed');
  ok('P-26-031 stays active (still in C-0101 and C-0102)', s2.populations.find(p => p.id === 'P-26-031').status === 'Active');
  ok('P-26-031 now lists P-26-045 as a descendant', E.lineage(s2, 'P-26-031').descendantIds.join() === 'P-26-045');
  ok('consolidating different stages is refused', /different stages/.test(E.merge(s2, { containers: ['C-0105', 'C-0101'], into: 'C-0112', operator: 'op1' }).problems.join()));
  ok('consolidating different species is refused', /Different species/.test(E.merge(s2, { containers: ['C-0201', 'C-0105'], into: 'C-0112', operator: 'op1' }).problems.join()));
  ok('consolidating into an occupied third container is refused', /already holds/.test(E.merge(s2, { containers: ['C-0201', 'C-0202'], into: 'C-0101', operator: 'op1' }).problems.join()));
  ok('one container alone is refused', /at least two/.test(E.merge(s2, { containers: ['C-0201'], into: 'C-0201', operator: 'op1' }).problems.join()));
}

sec('6. Lifecycle stage, history and export');
{
  const s = fresh();
  const st = E.advanceStage(s, 'P-26-034', 'op1');
  ok('P-26-034 moves from early to mid larva, logged as a transaction', st.ok && s.populations.find(p => p.id === 'P-26-034').stage === 'Mid larva' && st.tx.type === 'Stage');
  ok('a closed population cannot change stage', !E.advanceStage(s, 'P-26-027', 'op1').ok);
  const h = E.history(s, { container: 'C-0101' });
  ok('C-0101 history: 2 services in date order', h.length === 2 && h[0].id === 'T-0010' && h[1].id === 'T-0018');
  const withParents = E.history(s, { population: 'P-26-040', withAncestors: true });
  ok('P-26-040 history can include its parents\' trays before the merge', withParents.map(t => t.id).join() === 'T-0003,T-0004,T-0016', withParents.map(t => t.id));
  const out = E.csv(s, withParents);
  ok('CSV export has a header and one line per service', out.split('\n').length === 4 && /^Transaction,Date and time,Container/.test(out));
  ok('CSV quotes fields with commas', E.csv(s, [Object.assign({}, h[0], { notes: 'wet, then dry' })]).includes('"wet, then dry"'));
  const b = E.board(s);
  ok('floor view: 15 containers, 9 active, 6 empty, 8 due for service', b.containers === 15 && b.active === 9 && b.empty === 6 && b.due === 8, b);
}

console.log('\n' + (pass + fail) + ' checks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
