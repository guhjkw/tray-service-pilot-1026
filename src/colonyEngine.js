/*
 * src/colonyEngine.js
 * The logic behind the W1410 Routine Tray Service pilot. It keeps a relational model: populations (PID), containers
 * (CID), container assignments over time, lineage links and an append-only transaction log. An operator enters or
 * scans a container ID, the app pulls the population and its last service, validates the measurements and records
 * the transaction. A split keeps the population's identity across containers; consolidating different populations
 * creates a new population whose lineage lists every parent and its share, so any tray can be traced back to where
 * it started. The page (index.html) and the tests (tests/verify.js) load this same file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ColonyEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_RULES = { massMin: 200, massMax: 6000, waterMax: 400, feedMax: 800, massChangeReview: 25, notesMax: 500, dueAfterDays: 3,
    observations: ['Mortality above normal', 'Mold', 'Mites', 'Odor', 'Too wet', 'Too dry', 'Escapes'], reviewObservations: ['Mold', 'Mites', 'Mortality above normal'] };

  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function day(s) { return String(s || '').slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(day(b) + 'T00:00:00Z') - Date.parse(day(a) + 'T00:00:00Z')) / 86400000); }
  function pad(n, w) { return ('0000' + n).slice(-w); }

  // ---------------------------------------------------------------- data check: bad rows are skipped and reported
  function prepare(raw) {
    var p = [], d = copy(raw || {});
    function keep(list, label, test) {
      var seen = {};
      return (list || []).filter(function (r, i) {
        var ok = r && r.id !== undefined ? !seen[r.id] && test(r) : test(r);
        if (!ok) p.push(label + ' row ' + (i + 1) + ' skipped');
        else if (r && r.id !== undefined) seen[r.id] = 1;
        return ok;
      });
    }
    d.species = keep(d.species, 'Species', function (s) { return s.id && Array.isArray(s.stages) && s.stages.length; });
    var sp = {}; d.species.forEach(function (s) { sp[s.id] = s; });
    d.operators = keep(d.operators, 'Operator', function (o) { return o.id && o.name; });
    d.containers = keep(d.containers, 'Container', function (c) { return /^C-\d{4}$/.test(c.id || ''); });
    var cs = {}; d.containers.forEach(function (c) { cs[c.id] = 1; });
    d.populations = keep(d.populations, 'Population', function (x) { return /^P-\d{2}-\d{3}$/.test(x.id || '') && sp[x.species] && sp[x.species].stages.indexOf(x.stage) >= 0; });
    var ps = {}; d.populations.forEach(function (x) { ps[x.id] = 1; });
    d.assignments = keep(d.assignments, 'Assignment', function (a) { return cs[a.container] && ps[a.population] && /^\d{4}-\d{2}-\d{2}$/.test(a.from || ''); });
    var open = {};
    d.assignments = d.assignments.filter(function (a, i) {
      if (a.to) return true;
      if (open[a.container]) { p.push('Assignment for ' + a.container + ' skipped: a container can hold only one population at a time'); return false; }
      open[a.container] = 1; return true;
    });
    d.lineage = keep(d.lineage, 'Lineage', function (l) { return ps[l.child] && ps[l.parent] && l.child !== l.parent && l.share > 0 && l.share <= 1; });
    d.transactions = keep(d.transactions, 'Transaction', function (t) { return /^T-\d{4}$/.test(t.id || '') && t.type && t.at; });
    d.rules = Object.assign({}, DEFAULT_RULES, d.rules || {});
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d.today || '')) { p.push('"today" is missing, so 2026-10-26 09:00 is used'); d.today = '2026-10-26 09:00'; }
    return { data: d, problems: p };
  }

  function newState(data) {
    var d = copy(data);
    var st = { facility: d.facility, today: d.today, rules: d.rules, operators: d.operators, species: d.species, containers: d.containers,
      populations: d.populations, lineage: d.lineage, assignments: d.assignments, tx: d.transactions, clock: 0 };
    st.txSeq = st.tx.reduce(function (m, t) { return Math.max(m, +t.id.slice(2)); }, 0);
    st.popSeq = st.populations.reduce(function (m, x) { return Math.max(m, +x.id.slice(5)); }, 0);
    return st;
  }

  // ---------------------------------------------------------------- lookups
  function species(st, id) { return st.species.filter(function (s) { return s.id === id; })[0] || null; }
  function pop(st, id) { return st.populations.filter(function (x) { return x.id === id; })[0] || null; }
  function container(st, id) { return st.containers.filter(function (c) { return c.id === id; })[0] || null; }
  function operator(st, id) { return st.operators.filter(function (o) { return o.id === id; })[0] || null; }
  function current(st, cid) { return st.assignments.filter(function (a) { return a.container === cid && !a.to; })[0] || null; }
  function activeContainers(st, pid) { return st.assignments.filter(function (a) { return a.population === pid && !a.to; }).map(function (a) { return a.container; }); }
  function services(st, cid) { return st.tx.filter(function (t) { return t.type === 'W1410' && t.container === cid; }); }
  function lastService(st, cid) { var s = services(st, cid); return s.length ? s[s.length - 1] : null; }
  function now(st) { var m = (9 * 60 + st.clock++); return day(st.today) + ' ' + pad(Math.floor(m / 60), 2) + ':' + pad(m % 60, 2); }
  function nextTx(st) { st.txSeq += 1; return 'T-' + pad(st.txSeq, 4); }
  function normalize(cid) { var m = /^\s*C?-?\s*(\d{1,4})\s*$/i.exec(String(cid || '')); return m ? 'C-' + pad(+m[1], 4) : String(cid || '').trim().toUpperCase(); }

  // Scanning or typing a container ID pulls everything the operator needs.
  function lookup(st, cidRaw) {
    var cid = normalize(cidRaw), c = container(st, cid);
    if (!c) return { ok: false, problems: ['No container ' + cid + ' in the register'] };
    var a = current(st, cid);
    if (!a) return { ok: true, container: c, empty: true, message: cid + ' is empty: no population to service' };
    var x = pop(st, a.population), s = species(st, x.species), last = lastService(st, cid);
    return { ok: true, container: c, empty: false, population: x, species: s, stage: x.stage, ageDays: daysBetween(x.created, st.today), inSince: a.from,
      sharedWith: activeContainers(st, x.id).filter(function (id) { return id !== cid; }), last: last,
      servicedToday: !!(last && day(last.at) === day(st.today)), parents: st.lineage.filter(function (l) { return l.child === x.id; }) };
  }

  // ---------------------------------------------------------------- W1410 Routine Tray Service
  function num(v) { return v === '' || v == null ? NaN : Number(v); }
  function checkService(st, f) {
    var r = st.rules, p = [], warn = [], look = lookup(st, f.container);
    if (!look.ok) return { problems: look.problems, warnings: [] };
    if (look.empty) return { problems: [look.message], warnings: [] };
    if (look.servicedToday) p.push(look.container.id + ' was already serviced today (' + look.last.id + ' at ' + look.last.at.slice(11) + '); edit that record instead');
    if (!operator(st, f.operator)) p.push('Choose the operator');
    var mass = num(f.mass), water = num(f.water), feed = num(f.feed);
    if (!(mass >= r.massMin && mass <= r.massMax)) p.push('Tray mass must be ' + r.massMin + ' to ' + r.massMax + ' g');
    if (!(water >= 0 && water <= r.waterMax)) p.push('Water added must be 0 to ' + r.waterMax + ' mL');
    if (!(feed >= 0 && feed <= r.feedMax)) p.push('Feed applied must be 0 to ' + r.feedMax + ' g');
    var obs = (f.obs || []).filter(function (o, i, a) { return a.indexOf(o) === i; });
    var unknown = obs.filter(function (o) { return r.observations.indexOf(o) < 0; });
    if (unknown.length) p.push('Unknown observation: ' + unknown.join(', '));
    if (obs.indexOf('Too wet') >= 0 && obs.indexOf('Too dry') >= 0) p.push('A tray cannot be both too wet and too dry');
    if (String(f.notes || '').length > r.notesMax) p.push('Notes must be under ' + r.notesMax + ' characters');
    if (!p.length && look.last) {
      var change = Math.round(Math.abs(mass - look.last.mass) / look.last.mass * 100);
      if (change > r.massChangeReview) warn.push('Tray mass changed ' + change + '% since ' + look.last.id + ' (' + look.last.mass + ' g)');
    }
    obs.filter(function (o) { return r.reviewObservations.indexOf(o) >= 0; }).forEach(function (o) { warn.push('Observation needs review: ' + o); });
    return { problems: p, warnings: warn, look: look, values: { mass: mass, water: water, feed: feed, obs: obs } };
  }
  function recordService(st, f) {
    var c = checkService(st, f);
    if (c.problems.length) return { ok: false, problems: c.problems };
    var v = c.values, look = c.look;
    var t = { id: nextTx(st), type: 'W1410', at: now(st), operator: f.operator, container: look.container.id, population: look.population.id,
      mass: v.mass, water: v.water, feed: v.feed, obs: v.obs, notes: String(f.notes || '').trim(), status: c.warnings.length ? 'Needs review' : 'Recorded', warnings: c.warnings };
    st.tx.push(t);
    var trace = [
      { name: 'Scan', out: look.container.id + ' on rack ' + look.container.rack + ', shelf ' + look.container.shelf },
      { name: 'Lookup', out: look.population.id + ' · ' + look.species.name + ' · ' + look.stage + ' · day ' + look.ageDays + (look.sharedWith.length ? ' · also in ' + look.sharedWith.join(', ') : '') },
      { name: 'Validate', out: 'Mass ' + v.mass + ' g, water ' + v.water + ' mL, feed ' + v.feed + ' g: within limits' },
      { name: 'Compare', out: look.last ? 'Last service ' + look.last.id + ' on ' + day(look.last.at) + ': ' + look.last.mass + ' g' + (c.warnings.length ? '' : ', change within ' + st.rules.massChangeReview + '%') : 'First service for this container' },
      { name: 'Record', out: t.id + ' saved as ' + t.status + (c.warnings.length ? ': ' + c.warnings.join('; ') : '') }
    ];
    return { ok: true, tx: t, warnings: c.warnings, trace: trace };
  }

  // ---------------------------------------------------------------- split: one population, more containers, same PID
  function split(st, f) {
    var src = normalize(f.from), dests = (f.to || []).map(normalize), p = [];
    var a = current(st, src);
    if (!container(st, src)) p.push('No container ' + src);
    else if (!a) p.push(src + ' is empty, so there is nothing to split');
    if (!dests.length) p.push('Choose at least one empty container to split into');
    dests.forEach(function (d, i) {
      if (dests.indexOf(d) !== i) p.push(d + ' is listed twice');
      else if (d === src) p.push('The source container cannot also be a destination');
      else if (!container(st, d)) p.push('No container ' + d);
      else if (current(st, d)) p.push(d + ' already holds ' + current(st, d).population);
    });
    if (!operator(st, f.operator)) p.push('Choose the operator');
    if (p.length) return { ok: false, problems: p.filter(function (x, i) { return p.indexOf(x) === i; }) };
    var at = now(st);
    dests.forEach(function (d) { st.assignments.push({ container: d, population: a.population, from: day(at), to: null }); });
    var t = { id: nextTx(st), type: 'Split', at: at, operator: f.operator, population: a.population, containers: [src].concat(dests),
      note: 'Split ' + src + ' into ' + [src].concat(dests).join(', ') + ' (same population ' + a.population + ')' };
    st.tx.push(t);
    return { ok: true, tx: t, population: a.population };
  }

  // ---------------------------------------------------------------- consolidation: same PID stays, different PIDs make a new one
  function merge(st, f) {
    var srcs = (f.containers || []).map(normalize), into = normalize(f.into), p = [];
    srcs = srcs.filter(function (x, i) { return srcs.indexOf(x) === i; });
    if (srcs.length < 2) p.push('Choose at least two containers to consolidate');
    var rows = srcs.map(function (c) { return { c: c, a: current(st, c) }; });
    rows.forEach(function (r) { if (!container(st, r.c)) p.push('No container ' + r.c); else if (!r.a) p.push(r.c + ' is empty'); });
    if (!container(st, into)) p.push('Choose the destination container');
    else if (srcs.indexOf(into) < 0 && current(st, into)) p.push(into + ' already holds ' + current(st, into).population + '; consolidate into one of the sources or an empty container');
    if (!operator(st, f.operator)) p.push('Choose the operator');
    if (p.length) return { ok: false, problems: p };
    var pids = rows.map(function (r) { return r.a.population; }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    var pops = pids.map(function (id) { return pop(st, id); });
    if (pops.some(function (x) { return x.species !== pops[0].species; })) return { ok: false, problems: ['Different species cannot be consolidated'] };
    if (pops.some(function (x) { return x.stage !== pops[0].stage; })) return { ok: false, problems: ['Populations are at different stages (' + pops.map(function (x) { return x.id + ' ' + x.stage; }).join(', ') + ')'] };
    var at = now(st), d = day(at), t = { id: nextTx(st), type: 'Merge', at: at, operator: f.operator, containers: srcs.concat(srcs.indexOf(into) < 0 ? [into] : []) };
    rows.forEach(function (r) { r.a.to = d; });
    if (pids.length === 1) {
      st.assignments.push({ container: into, population: pids[0], from: d, to: null });
      t.population = pids[0]; t.note = 'Consolidated ' + srcs.join(' and ') + ' into ' + into + ' (same population ' + pids[0] + ', identity kept)';
      st.tx.push(t);
      return { ok: true, tx: t, population: pids[0], created: false };
    }
    // Shares come from each tray's latest recorded mass, so the lineage says how much of the new population came from where.
    var mass = {};
    rows.forEach(function (r) { var l = lastService(st, r.c); mass[r.a.population] = (mass[r.a.population] || 0) + (l ? l.mass : 0); });
    var total = pids.reduce(function (s, id) { return s + mass[id]; }, 0);
    st.popSeq += 1;
    var nid = 'P-' + day(st.today).slice(2, 4) + '-' + pad(st.popSeq, 3);
    st.populations.push({ id: nid, species: pops[0].species, stage: pops[0].stage, origin: 'Merged', created: d, status: 'Active' });
    pids.forEach(function (id) {
      st.lineage.push({ child: nid, parent: id, share: total ? Math.round(mass[id] / total * 100) / 100 : Math.round(1 / pids.length * 100) / 100, event: t.id });
      if (!activeContainers(st, id).length) pop(st, id).status = 'Closed';
    });
    st.assignments.push({ container: into, population: nid, from: d, to: null });
    t.population = nid; t.note = 'Consolidated ' + pids.join(' and ') + ' into new population ' + nid + ' in ' + into;
    st.tx.push(t);
    return { ok: true, tx: t, population: nid, created: true };
  }

  function advanceStage(st, pid, opId) {
    var x = pop(st, pid);
    if (!x || x.status !== 'Active') return { ok: false, problems: ['Only an active population can change stage'] };
    if (!operator(st, opId)) return { ok: false, problems: ['Choose the operator'] };
    var stages = species(st, x.species).stages, i = stages.indexOf(x.stage);
    if (i >= stages.length - 1) return { ok: false, problems: [pid + ' is already at the last stage'] };
    var from = x.stage; x.stage = stages[i + 1];
    var t = { id: nextTx(st), type: 'Stage', at: now(st), operator: opId, population: pid, containers: activeContainers(st, pid), note: pid + ': ' + from + ' to ' + x.stage };
    st.tx.push(t);
    return { ok: true, tx: t };
  }

  // ---------------------------------------------------------------- lineage: where a population came from and where it went
  function ancestors(st, pid, seen) {
    seen = seen || {};
    return st.lineage.filter(function (l) { return l.child === pid && !seen[l.parent]; }).map(function (l) {
      seen[l.parent] = 1;
      return { id: l.parent, share: l.share, event: l.event, parents: ancestors(st, l.parent, seen) };
    });
  }
  function descendants(st, pid, seen) {
    seen = seen || {};
    return st.lineage.filter(function (l) { return l.parent === pid && !seen[l.child]; }).map(function (l) {
      seen[l.child] = 1;
      return { id: l.child, share: l.share, event: l.event, children: descendants(st, l.child, seen) };
    });
  }
  function flatten(tree, key) { return tree.reduce(function (a, n) { return a.concat([n.id], flatten(n[key] || [], key)); }, []); }
  function lineage(st, pid) {
    var x = pop(st, pid);
    if (!x) return { ok: false, problems: ['No population ' + pid] };
    var up = ancestors(st, pid), down = descendants(st, pid);
    return { ok: true, population: x, ancestors: up, descendants: down, ancestorIds: flatten(up, 'parents'), descendantIds: flatten(down, 'children'),
      containers: st.assignments.filter(function (a) { return a.population === pid; }), now: activeContainers(st, pid) };
  }

  // ---------------------------------------------------------------- service history, export and the floor view
  function history(st, f) {
    f = f || {};
    var pids = null;
    if (f.population) { var lg = lineage(st, f.population); pids = [f.population].concat(f.withAncestors && lg.ok ? lg.ancestorIds : []); }
    return st.tx.filter(function (t) {
      if (t.type !== 'W1410') return false;
      if (f.container && t.container !== normalize(f.container)) return false;
      if (pids && pids.indexOf(t.population) < 0) return false;
      return true;
    }).slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  }
  function csv(st, rows) {
    function q(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var head = ['Transaction', 'Date and time', 'Container', 'Population', 'Operator', 'Tray mass (g)', 'Water (mL)', 'Feed (g)', 'Observations', 'Status', 'Notes'];
    return [head.join(',')].concat(rows.map(function (t) {
      var o = operator(st, t.operator);
      return [t.id, t.at, t.container, t.population, o ? o.name : t.operator, t.mass, t.water, t.feed, (t.obs || []).join('; '), t.status, t.notes || ''].map(q).join(',');
    })).join('\n');
  }
  function floor(st) {
    return st.containers.map(function (c) {
      var a = current(st, c.id), last = lastService(st, c.id);
      var x = a ? pop(st, a.population) : null;
      var age = last ? daysBetween(last.at, st.today) : null;
      return { id: c.id, rack: c.rack, shelf: c.shelf, population: x ? x.id : null, species: x ? x.species : null, stage: x ? x.stage : null,
        last: last ? last.at : null, lastStatus: last ? last.status : null, servicedToday: age === 0, due: !!x && (age === null || age >= st.rules.dueAfterDays) };
    });
  }
  function board(st) {
    var f = floor(st), active = f.filter(function (x) { return x.population; });
    var today = st.tx.filter(function (t) { return t.type === 'W1410' && day(t.at) === day(st.today); });
    return { containers: f.length, active: active.length, empty: f.length - active.length, due: active.filter(function (x) { return x.due; }).length,
      servicedToday: today.length, review: st.tx.filter(function (t) { return t.status === 'Needs review'; }).length,
      populations: st.populations.filter(function (x) { return x.status === 'Active'; }).length };
  }

  return {
    DEFAULT_RULES: DEFAULT_RULES,
    prepare: prepare, newState: newState, lookup: lookup, checkService: checkService, recordService: recordService, split: split, merge: merge,
    advanceStage: advanceStage, lineage: lineage, history: history, csv: csv, floor: floor, board: board, normalize: normalize
  };
});
