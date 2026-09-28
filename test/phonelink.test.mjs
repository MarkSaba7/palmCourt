// Which route the phone racket's WebRTC link took, from getStats (src/phonelink.js).
//   node test/phonelink.test.mjs
import assert from 'node:assert/strict';
import { routeName, selectedPair } from '../src/phonelink.js';

const c = (type, address) => ({ type, address });
assert.equal(routeName(c('host', '192.168.1.20'), c('host', '192.168.1.31')), 'Wi-Fi direct');
assert.equal(routeName(c('host', '192.168.1.20'), c('prflx', '192.168.1.31')), 'Wi-Fi direct');   // the phone's hidden .local address, learned from its checks
assert.equal(routeName(c('host', '10.0.0.4'), c('host', '3f1c2a9e-1b2c.local')), 'Wi-Fi direct');
assert.equal(routeName(c('host', 'fd00::4'), c('prflx', 'fe80::1c2:3ff:fe4:5')), 'Wi-Fi direct');
assert.equal(routeName(c('host', '192.168.1.20'), c('prflx', '100.64.12.9')), 'internet');       // mobile data
assert.equal(routeName(c('srflx', '81.2.69.160'), c('srflx', '203.0.113.7')), 'internet');
assert.equal(routeName(c('host', '192.168.1.20'), c('relay', '198.51.100.3')), 'TURN relay');
assert.equal(routeName(c('relay', '198.51.100.3'), c('host', '192.168.1.31')), 'TURN relay');
assert.equal(routeName(null, c('host', '')), '');

// Chrome and Safari name the pair in use on the transport; Firefox marks it selected.
const map = (list) => new Map(list.map((s) => [s.id, s]));
const cands = [
  { id: 'L1', type: 'local-candidate', candidateType: 'host', address: '192.168.1.20' },
  { id: 'R1', type: 'remote-candidate', candidateType: 'prflx', address: '192.168.1.31' },
  { id: 'L2', type: 'local-candidate', candidateType: 'relay', address: '198.51.100.3' },
  { id: 'R2', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.7' },
];
const chrome = map([...cands,
  { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded', nominated: true, currentRoundTripTime: 0.018 },
  { id: 'P2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R2', state: 'succeeded', nominated: false, currentRoundTripTime: 0.09 },
  { id: 'T', type: 'transport', selectedCandidatePairId: 'P1' },
]);
assert.deepEqual(selectedPair(chrome), { local: { type: 'host', address: '192.168.1.20' }, remote: { type: 'prflx', address: '192.168.1.31' }, rtt: 18 });
const firefox = map([...cands,
  { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded', nominated: true },
  { id: 'P2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R2', state: 'succeeded', nominated: true, selected: true },
]);
const ff = selectedPair(firefox);
assert.equal(routeName(ff.local, ff.remote), 'TURN relay');
assert.equal(ff.rtt, 0);
assert.equal(selectedPair(map(cands)), null);
console.log('phonelink: all tests passed');
