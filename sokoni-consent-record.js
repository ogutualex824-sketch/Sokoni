/* ============================================================================
   SOKONI — durable sign-up consent record (one writer for the sign-up surfaces that are not
   signup.html, which keeps its own proven inline copy in auth.js)
   ----------------------------------------------------------------------------
   WHY (census 2026-10-01): every "Create Free Account" entry opens onboarding.html?mode=signup,
   which created the Firebase account with no notice, no terms/privacy acceptance, no age
   confirmation and no consentRecords row. Google and phone sign-in wrote none either.

   Consent is recorded ONLY after the person ticked the boxes on the page:
     terms + privacy + ageConfirmed (18 or older)  — required, shown unticked
     marketing                                     — optional, unticked, separate
   consentRecords/{auto}: { uid, source, policyVersion, terms, privacy, ageConfirmed, marketing,
                            consentedAt }   (served rules: owner create, immutable, owner/admin read)
   users/{uid}.consent  : latest snapshot (best effort — the append-only row is the proof)

   The policy version MUST match auth.js (POLICY_VERSION) so records from both writers compare.
   ============================================================================ */
(function (g) {
  'use strict';
  var POLICY_VERSION = '2026-06';
  var FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  /* Read the consent block the page rendered. Returns null if any required box is unticked. */
  function readChoices(root) {
    root = root || document;
    var q = function (id) { var el = root.querySelector('#' + id); return !!(el && el.checked); };
    var c = { terms: q('cnTerms'), privacy: q('cnPrivacy'), ageConfirmed: q('cnAge'), marketing: q('cnMkt') };
    return (c.terms && c.privacy && c.ageConfirmed) ? c : null;
  }

  function _waitDb(ms) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function tick() {
        if (g.firebaseDB) return resolve(g.firebaseDB);
        if (Date.now() - t0 > (ms || 8000)) return reject(new Error('Firestore not ready'));
        setTimeout(tick, 100);
      })();
    });
  }

  /* Write the record for the signed-in user. Resolves {recorded:true} or throws — never
     pretends. Skips (recorded:false, reason:'already') if this user already has a consent
     snapshot for the current policy version, so a returning Google/phone user is not
     re-recorded on every sign-in. */
  async function record(user, source, choices, deps) {
    if (!user || !user.uid) throw new Error('No signed-in user');
    if (!choices || !choices.terms || !choices.privacy || !choices.ageConfirmed) throw new Error('Required consent missing');
    var db = (deps && deps.db) || await _waitDb();
    var fs = (deps && deps.fs) || await import(FS_URL);   /* deps: tests only */
    try {
      var snap = await fs.getDoc(fs.doc(db, 'users', user.uid));
      var cur = snap.exists() ? (snap.data() || {}).consent : null;
      if (cur && cur.policyVersion === POLICY_VERSION && cur.terms && cur.privacy) return { recorded: false, reason: 'already' };
    } catch (_) { /* unreadable → record anyway; an extra immutable row is harmless */ }
    await fs.addDoc(fs.collection(db, 'consentRecords'), {
      uid: user.uid, source: String(source || 'onboarding').slice(0, 40), policyVersion: POLICY_VERSION,
      terms: true, privacy: true, ageConfirmed: true, marketing: !!choices.marketing,
      consentedAt: fs.serverTimestamp(),
    });
    try {
      await fs.setDoc(fs.doc(db, 'users', user.uid), {
        consent: { policyVersion: POLICY_VERSION, source: String(source || 'onboarding').slice(0, 40), terms: true, privacy: true,
                   ageConfirmed: true, marketing: !!choices.marketing, consentedAt: fs.serverTimestamp() },
      }, { merge: true });
    } catch (e) {
      /* The snapshot is a convenience; the append-only row above is the lawful-basis proof. */
      if (g.console) console.warn('[consent] profile snapshot not written:', e && e.code);
    }
    return { recorded: true };
  }

  /* The consent block, shared by every sign-up method on a page. Unticked by default;
     marketing is a separate optional box (never bundled into the required terms). */
  function blockHtml() {
    return '<fieldset class="cn-block" style="border:1px solid rgba(255,255,255,0.14);border-radius:12px;padding:12px 14px;margin:12px 0;">' +
      '<legend style="font-size:.78rem;font-weight:700;padding:0 6px;">Before you continue</legend>' +
      '<p style="font-size:.78rem;line-height:1.5;margin:0 0 8px;color:rgba(255,255,255,0.75);">We use your name, email or phone to create and secure your account and to process your orders. ' +
      'Read how in our <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.8rem;margin:6px 0;"><input type="checkbox" id="cnTerms" required style="margin-top:3px;width:18px;height:18px;"> ' +
      '<span>I agree to the <a href="terms.html" target="_blank" rel="noopener">Terms of Service</a>. <em>(required)</em></span></label>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.8rem;margin:6px 0;"><input type="checkbox" id="cnPrivacy" required style="margin-top:3px;width:18px;height:18px;"> ' +
      '<span>I have read the <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>. <em>(required)</em></span></label>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.8rem;margin:6px 0;"><input type="checkbox" id="cnAge" required style="margin-top:3px;width:18px;height:18px;"> ' +
      '<span>I am 18 years or older. <em>(required)</em></span></label>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.8rem;margin:6px 0;"><input type="checkbox" id="cnMkt" style="margin-top:3px;width:18px;height:18px;"> ' +
      '<span>Send me offers and news from SOKONI. <em>(optional — you can change this any time)</em></span></label>' +
      '</fieldset>';
  }

  g.SokoniConsentRecord = Object.freeze({ POLICY_VERSION: POLICY_VERSION, readChoices: readChoices, record: record, blockHtml: blockHtml });
})(typeof window !== 'undefined' ? window : globalThis);
