/* Index-file diff gate: what would `firebase deploy --only firestore:indexes`
   actually do? READ ONLY — compares repo firestore.indexes.json against the
   deployed composite index set already fetched to JSON. */
'use strict';
const fs = require('fs');

const repo = JSON.parse(fs.readFileSync(process.argv[3] || 'firestore.indexes.json', 'utf8'));
const deployed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

/* Canonical key. __name__ is appended implicitly by Firestore and is omitted
   from the repo file, so it must be stripped from BOTH sides or every index
   looks different. */
function key(cg, scope, fields) {
  const f = (fields || [])
    .filter((x) => x.fieldPath !== '__name__')
    .map((x) => `${x.fieldPath}:${x.order || x.arrayConfig || '?'}`)
    .join(',');
  return `${cg}|${scope || 'COLLECTION'}|${f}`;
}

const repoSet = new Map();
for (const i of repo.indexes || []) {
  repoSet.set(key(i.collectionGroup, i.queryScope, i.fields), i);
}

const depSet = new Map();
for (const i of deployed) {
  /* name: projects/P/databases/D/collectionGroups/CG/indexes/ID */
  const m = /collectionGroups\/([^/]+)\/indexes\//.exec(i.name || '');
  const cg = m ? m[1] : '(unknown)';
  depSet.set(key(cg, i.queryScope, i.fields), { cg, i });
}

const wouldCreate = [...repoSet.entries()].filter(([k]) => !depSet.has(k));
const onlyDeployed = [...depSet.entries()].filter(([k]) => !repoSet.has(k));

console.log('INDEX DIFF GATE — repo vs deployed');
console.log('='.repeat(76));
console.log(`  repo composite indexes     : ${(repo.indexes || []).length}`);
console.log(`  deployed composite indexes : ${deployed.length}`);
console.log(`  repo fieldOverrides        : ${(repo.fieldOverrides || []).length}`);

console.log(`\n-- WOULD BE CREATED by a deploy (in repo, not deployed): ${wouldCreate.length}`);
for (const [k, v] of wouldCreate) {
  console.log(`   + ${v.collectionGroup}  [${(v.fields || []).map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig)).join(', ')}]`);
}
if (!wouldCreate.length) console.log('   (none)');

console.log(`\n-- DEPLOYED BUT NOT IN REPO: ${onlyDeployed.length}`);
for (const [k, v] of onlyDeployed) {
  console.log(`   - ${v.cg}  [${(v.i.fields || []).filter((f) => f.fieldPath !== '__name__').map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig)).join(', ')}]`);
}
if (!onlyDeployed.length) console.log('   (none)');

/* The specific index P0-8 needs */
const needed = key('syncQueue', 'COLLECTION',
  [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'updatedAt', order: 'ASCENDING' }]);
console.log('\n-- THE P0-8 INDEX: syncQueue(status ASC, updatedAt ASC)');
console.log(`   in repo     : ${repoSet.has(needed) ? 'YES' : 'NO'}`);
console.log(`   deployed    : ${depSet.has(needed) ? 'YES' : 'NO'}`);
console.log(`   any syncQueue index deployed at all: ${[...depSet.values()].filter((v) => v.cg === 'syncQueue').length}`);

console.log('\n' + '='.repeat(76));
console.log('READ THIS BEFORE ANY INDEX DEPLOY');
console.log('='.repeat(76));
console.log('  `firebase deploy --only firestore:indexes` sends the WHOLE file.');
console.log('  Every index in the CREATED list above ships together — you cannot');
console.log('  deploy one index. Index builds are also asynchronous and consume');
console.log('  write capacity while they run.');
console.log('  Entries in DEPLOYED-BUT-NOT-IN-REPO are candidates the tooling may');
console.log('  offer to DELETE. Deleting an index that a live query depends on');
console.log('  breaks that query with FAILED_PRECONDITION at runtime.');
