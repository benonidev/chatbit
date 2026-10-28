// Tests of the room key cryptography (docs/room-keys.md). Run: node --test tests/js
import {test} from "node:test";
import assert from "node:assert/strict";
import {
    buildJoinRequest, buildKeyUpdate, buildRotation, epochKeys, fingerprint, memberIdOf, newExchangeKey,
    newIdentity, newRoomSecret, openJoinRequest, openKeyUpdate, openRotation, RoomCryptoError, rosterEntry,
    signMessage, verifyMessage, b64, unb64,
} from "../../dist/assets/js/adapter/room_crypto.js";

const roomId = "6f1c2c1e-6a8e-4c63-9d0e-0d6f2f6b9a11";

async function member(alias) {
    const identity = await newIdentity();
    return {identity, entry: rosterEntry(roomId, identity, alias)};
}

// Opens a rotation the way a member of the previous epoch does
function openAs(m, rot, epoch, prev, G) {
    return openRotation({roomId, G, body: rot.body, expectedEpoch: epoch, prev, identity: m.identity});
}

async function rejects(promise, reason) {
    await assert.rejects(promise, err => err instanceof RoomCryptoError && err.reason === reason);
}

test("member id and fingerprint come from the Ed25519 key", async () => {
    const {identity} = await member("alice");
    assert.equal(identity.memberId, memberIdOf(identity.ed));
    assert.equal(identity.memberId.length, 32);
    assert.match(fingerprint(identity.memberId), /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
});

test("create, add, leave: every member gets K and J, a removed member does not", async () => {
    const G = newRoomSecret();
    const alice = await member("alice"), bob = await member("bob"), carol = await member("carol");

    // epoch 1: Alice alone
    const r1 = await buildRotation({roomId, G, epoch: 1, prevHash: null, identity: alice.identity, roster: [alice.entry], reason: "create"});
    const a1 = await openAs(alice, r1, 1, null, G);
    assert.equal(a1.member, true);
    assert.equal(a1.K, r1.K);
    assert.equal(a1.J, r1.joinSecret);

    // epoch 2: Bob and Carol added
    const r2 = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: alice.identity,
        roster: [alice.entry, bob.entry, carol.entry], reason: "add", subject: bob.entry.memberId});
    // Bob is new: no previous epoch, the signer must be his inviter (member id from the QR code)
    const b2 = await openRotation({roomId, G, body: r2.body, expectedEpoch: 2, prev: null, inviterId: alice.identity.memberId, identity: bob.identity});
    assert.equal(b2.member, true);
    assert.equal(b2.K, r2.K);
    assert.equal(b2.roster.length, 3);
    const a2 = await openAs(alice, r2, 2, {headerHash: a1.headerHash, roster: a1.roster}, G);
    assert.equal(a2.K, r2.K);

    // epoch 3: Bob leaves, Carol rotates
    const r3 = await buildRotation({roomId, G, epoch: 3, prevHash: r2.headerHash, identity: carol.identity,
        roster: [alice.entry, carol.entry], reason: "leave", subject: bob.entry.memberId});
    const prev2 = {headerHash: r2.headerHash, roster: b2.roster};
    const a3 = await openAs(alice, r3, 3, prev2, G);
    assert.equal(a3.K, r3.K);
    assert.deepEqual(a3.roster.map(m => m.alias).sort(), ["alice", "carol"]);

    // Bob still has G and the old roster — but no envelope
    const b3 = await openAs(bob, r3, 3, prev2, G);
    assert.equal(b3.member, false);
    assert.equal(b3.K, null);
    assert.equal(b3.J, null);
});

test("aliases are fixed: nobody can rename a member or add one with an alias it did not sign", async () => {
    const G = newRoomSecret();
    const alice = await member("alice"), bob = await member("bob"), mallory = await member("mallory");
    const r1 = await buildRotation({roomId, G, epoch: 1, prevHash: null, identity: alice.identity,
        roster: [alice.entry, bob.entry, mallory.entry], reason: "create"});
    const prev = {headerHash: r1.headerHash, roster: r1.roster};

    // Mallory writes the next roster and renames Bob to "admin" — Bob's own signature no longer fits
    // and his alias differs from the previous roster
    const renamed = {...bob.entry, alias: "admin"};
    const r2 = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: mallory.identity,
        roster: [alice.entry, renamed, mallory.entry], reason: "renew"});
    await rejects(openAs(alice, r2, 2, prev, G), "alias");

    // Even with a valid signature of Bob over another alias: an existing member keeps its alias
    const resigned = rosterEntry(roomId, bob.identity, "bobby");
    const r2b = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: mallory.identity,
        roster: [alice.entry, resigned, mallory.entry], reason: "renew"});
    await rejects(openAs(alice, r2b, 2, prev, G), "alias");

    // A new member whose alias was changed on the way (or never signed)
    const dave = await member("dave");
    for (const entry of [{...dave.entry, alias: "alice"}, {...dave.entry, aliasSig: undefined}]) {
        const r = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: mallory.identity,
            roster: [alice.entry, bob.entry, mallory.entry, entry], reason: "add", subject: dave.entry.memberId});
        await rejects(openAs(alice, r, 2, prev, G), "alias");
    }

    // The same alias of another room does not count either (the room id is signed)
    const otherRoom = rosterEntry("0b9f8a54-3c1d-4e2f-8a7b-6c5d4e3f2a1b", dave.identity, "dave");
    const r3 = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: alice.identity,
        roster: [alice.entry, bob.entry, mallory.entry, {...dave.entry, aliasSig: otherRoom.aliasSig}], reason: "add"});
    await rejects(openAs(alice, r3, 2, prev, G), "alias");

    // Unchanged aliases and a correctly signed new member are fine
    const ok = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: mallory.identity,
        roster: [alice.entry, bob.entry, mallory.entry, dave.entry], reason: "add", subject: dave.entry.memberId});
    assert.equal((await openAs(alice, ok, 2, prev, G)).roster.find(m => m.memberId === bob.entry.memberId).alias, "bob");
});

test("a new member only accepts a rotation signed by its inviter", async () => {
    const G = newRoomSecret();
    const alice = await member("alice"), eve = await member("eve"), dave = await member("dave");
    const r = await buildRotation({roomId, G, epoch: 4, prevHash: b64(new Uint8Array(32).fill(1)), identity: eve.identity,
        roster: [eve.entry, dave.entry], reason: "add"});
    await rejects(openRotation({roomId, G, body: r.body, expectedEpoch: 4, prev: null, inviterId: alice.identity.memberId, identity: dave.identity}), "signer");
});

test("rotations are rejected: wrong G, wrong epoch, broken chain, signer not a member, tampering", async () => {
    const G = newRoomSecret();
    const alice = await member("alice"), bob = await member("bob"), mallory = await member("mallory");
    const r1 = await buildRotation({roomId, G, epoch: 1, prevHash: null, identity: alice.identity, roster: [alice.entry, bob.entry], reason: "create"});
    const b1 = await openAs(bob, r1, 1, null, G).catch(() => null);
    assert.equal(b1, null, "epoch 1 without inviter or chain must not be accepted by a non-creator");

    const a1 = await openAs(alice, r1, 1, null, G);
    const prev = {headerHash: a1.headerHash, roster: a1.roster};

    const r2 = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: alice.identity, roster: [alice.entry, bob.entry], reason: "renew"});
    await rejects(openAs(bob, r2, 2, prev, newRoomSecret()), "body");             // server without G
    await rejects(openAs(bob, r2, 3, prev, G), "body");                            // replayed as another epoch
    await rejects(openAs(bob, r2, 2, {headerHash: b64(new Uint8Array(32)), roster: prev.roster}, G), "chain");

    // A non-member signs a rotation (it may know G, e.g. from an old QR code)
    const forged = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: mallory.identity,
        roster: [bob.entry, mallory.entry], reason: "add"});
    await rejects(openAs(bob, forged, 2, prev, G), "signature");

    // ... or tells Bob he was removed (no envelope for him)
    const fakeRemoval = await buildRotation({roomId, G, epoch: 2, prevHash: r1.headerHash, identity: mallory.identity,
        roster: [mallory.entry], reason: "remove", subject: bob.entry.memberId});
    await rejects(openAs(bob, fakeRemoval, 2, prev, G), "signature");

    // Flipped bit in the body
    const bytes = unb64(r2.body);
    bytes[40] ^= 1;
    await rejects(openAs(bob, {body: b64(bytes)}, 2, prev, G), "body");
});

test("an envelope sealed for the previous exchange key still opens after a renewal", async () => {
    const G = newRoomSecret();
    const alice = await member("alice"), bob = await member("bob");
    const r1 = await buildRotation({roomId, G, epoch: 1, prevHash: null, identity: alice.identity, roster: [alice.entry, bob.entry], reason: "create"});

    const renewed = {...bob.identity, xSeedPrevious: bob.identity.xSeed, ...await newExchangeKey()};
    const opened = await openRotation({roomId, G, body: r1.body, expectedEpoch: 1, prev: null, inviterId: alice.identity.memberId, identity: renewed});
    assert.equal(opened.K, r1.K);

    const lost = {...renewed, xSeedPrevious: undefined};
    await rejects(openRotation({roomId, G, body: r1.body, expectedEpoch: 1, prev: null, inviterId: alice.identity.memberId, identity: lost}), "envelope");
});

test("join request: the inviter detects swapped keys with the invite secret", async () => {
    const G = newRoomSecret();
    const s = b64(crypto.getRandomValues(new Uint8Array(16)));
    const alice = await member("alice"), dave = await member("dave"), server = await member("server");

    const request = await buildJoinRequest({roomId, G, s, identity: dave.identity, alias: "dave", inviterId: alice.identity.memberId});
    const opened = await openJoinRequest({roomId, G, request, s});
    assert.equal(opened.macOk, true);
    assert.equal(opened.entry.memberId, dave.identity.memberId);
    assert.equal(opened.entry.alias, "dave");

    // Members without s can read it, but not confirm it
    assert.equal((await openJoinRequest({roomId, G, request})).macOk, false);

    // Someone who knows G but not s builds a request with its own keys
    const swapped = await buildJoinRequest({roomId, G, s: b64(new Uint8Array(16)), identity: server.identity, alias: "dave", inviterId: alice.identity.memberId});
    assert.equal((await openJoinRequest({roomId, G, request: swapped, s})).macOk, false);

    await rejects(openJoinRequest({roomId, G: newRoomSecret(), request, s}), "request");
});

test("key update is accepted only from the member itself", async () => {
    const G = newRoomSecret();
    const alice = await member("alice"), bob = await member("bob");
    const keys = await epochKeys(roomId, 5, newRoomSecret(), G);
    const roster = [alice.entry, bob.entry];

    const renewed = {...bob.identity, ...await newExchangeKey()};
    const update = await buildKeyUpdate({roomId, epoch: 5, keys, identity: renewed});
    const u = await openKeyUpdate({roomId, epoch: 5, keys, update, roster});
    assert.equal(u.memberId, bob.identity.memberId);
    assert.equal(u.x, renewed.x);

    // Signed by someone else under Bob's member id
    const forged = await buildKeyUpdate({roomId, epoch: 5, keys, identity: {...alice.identity, memberId: bob.identity.memberId}});
    await rejects(openKeyUpdate({roomId, epoch: 5, keys, update: forged, roster}), "signature");
});

test("message signatures bind sender, room, epoch, id and content", async () => {
    const {identity} = await member("alice");
    const m = {roomId, epoch: 3, id: "m1", type: 0, content: "hello"};
    const sig = signMessage(identity, m);
    assert.equal(verifyMessage(identity.ed, m, sig), true);
    for (const change of [{content: "hello!"}, {epoch: 4}, {id: "m2"}, {alias: "bob"}, {type: 1}, {replyTo: "m0"}]) {
        assert.equal(verifyMessage(identity.ed, {...m, ...change}, sig), false, JSON.stringify(change));
    }

    // A reply signs the id of the message it answers — it can not be moved under another one
    const reply = {...m, id: "m3", replyTo: "m1"};
    const replySig = signMessage(identity, reply);
    assert.equal(verifyMessage(identity.ed, reply, replySig), true);
    assert.equal(verifyMessage(identity.ed, {...reply, replyTo: "m2"}, replySig), false);
    assert.equal(verifyMessage(identity.ed, {...reply, replyTo: undefined}, replySig), false);
    const other = await member("bob");
    assert.equal(verifyMessage(other.identity.ed, m, sig), false);
});

test("epoch keys depend on K, G, room and epoch", async () => {
    const G = newRoomSecret(), K = newRoomSecret();
    const encrypt = async keys => {
        const iv = new Uint8Array(12);
        return b64(new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv}, keys.messageKey, new Uint8Array([1]))));
    };
    const base = await encrypt(await epochKeys(roomId, 1, K, G));
    assert.equal(await encrypt(await epochKeys(roomId, 1, K, G)), base);
    assert.notEqual(await encrypt(await epochKeys(roomId, 2, K, G)), base);
    assert.notEqual(await encrypt(await epochKeys(roomId, 1, K, newRoomSecret())), base);
    assert.notEqual(await encrypt(await epochKeys(roomId, 1, newRoomSecret(), G)), base);
});
