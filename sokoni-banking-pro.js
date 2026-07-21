/* ============================================================
   SOKONI BANKING PRO  –  window.BankingPro
   Financial marketplace wallet platform (not a regulated bank).
   All data persisted via SokoniDB.saveApplication() + localStorage.
   ============================================================ */
window.BankingPro = (function(){
  'use strict';

  /* ── helpers ── */
  const $ = id => document.getElementById(id);
  const _esc = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = n => Number(n||0).toLocaleString('en-KE');
  const fmtK = n => { n=Number(n||0); return n>=1e6?'KES '+(n/1e6).toFixed(1)+'M': n>=1e3?'KES '+(n/1e3).toFixed(0)+'K':'KES '+Math.round(n).toLocaleString(); };
  const ts  = () => Date.now();
  const uid = () => (window.firebase?.auth?.()?.currentUser?.uid) || localStorage.getItem('sokoniUID') || 'guest';
  const now = () => new Date().toISOString();
  /* ── Admin authority ──────────────────────────────────────────────────
     This read localStorage.sokoniUser.isAdmin. Nothing on the platform ever
     writes that field — every other admin gate (firebase.js, franchise,
     executive-dashboard, and every Cloud Function) reads Firebase custom
     claims — so the flag was permanently false and legitimate administrators
     holding {"admin":true} were refused their own dashboard.

     Custom claims are now the single authority here too, matching the rest of
     the platform. A claim is minted server-side and carried in a signed ID
     token, so it cannot be forged from devtools the way a cached JSON blob
     could.

     Claims are cached in memory because the render path is synchronous.
     ensureAdmin() populates that cache and, when the cached token predates a
     recently-granted claim, forces one refresh before deciding — a newly
     promoted admin would otherwise stay locked out until their token happened
     to rotate. */
  let _claims = null, _claimsLoaded = false;

  function _authUser() {
    try { return window.firebase?.auth?.()?.currentUser || window.firebaseAuth?.currentUser || null; }
    catch (_) { return null; }
  }

  async function _loadClaims(force) {
    const u = _authUser();
    if (!u || typeof u.getIdTokenResult !== 'function') { _claimsLoaded = true; return null; }
    try {
      const res = await u.getIdTokenResult(!!force);
      _claims = res && res.claims ? res.claims : {};
    } catch (_) { /* keep whatever we had; never fail open */ }
    _claimsLoaded = true;
    return _claims;
  }

  const _claimsSayAdmin = (c) =>
    !!(c && (c.admin === true || c.superAdmin === true || c.isAdmin === true || c.isSuperAdmin === true));

  /* Synchronous view of the cached claims — safe for render paths. */
  const isAdmin = () => _claimsSayAdmin(_claims);

  /* Authoritative check. Loads claims if absent, then retries ONCE with a
     forced token refresh so a freshly-granted claim is honoured immediately. */
  async function ensureAdmin() {
    if (!_claimsLoaded) await _loadClaims(false);
    if (isAdmin()) return true;
    await _loadClaims(true);
    return isAdmin();
  }

  async function fsWrite(collection, data){
    try{
      if(window.SokoniDB?.saveApplication){
        await SokoniDB.saveApplication({ ...data, category: collection });
        return true;
      }
    }catch(e){}
    const key = 'bkpro_' + collection;
    const arr = JSON.parse(localStorage.getItem(key)||'[]');
    arr.unshift(data);
    localStorage.setItem(key, JSON.stringify(arr.slice(0,200)));
    return false;
  }
  function lsGet(key){ try{ return JSON.parse(localStorage.getItem(key)||'null'); }catch{ return null; } }
  function lsSet(key,val){ localStorage.setItem(key, JSON.stringify(val)); }
  function lsArr(key){ return lsGet(key)||[]; }

  /* ── WALLET ── */
  const WALLET_KEY = 'sokoniWallet';
  function getWallet(){
    return lsGet(WALLET_KEY) || { balance:0, currency:'KES', tier:'Basic', dailyLimit:10000, transactions:[] };
  }
  function saveWallet(w){ lsSet(WALLET_KEY, w); }

  function walletTx(type, amount, desc, ref){
    const w = getWallet();
    const tx = { id:'TX'+ts(), type, amount:Number(amount), desc, ref:ref||'', balance: w.balance + (type==='credit'?1:-1)*Number(amount), ts:ts() };
    w.transactions = [tx, ...(w.transactions||[])].slice(0,500);
    w.balance = tx.balance;
    saveWallet(w);
    addNotification('wallet', type==='credit'?'Money Received':'Money Sent',
      `${type==='credit'?'+':'-'}KES ${fmt(amount)} — ${desc}`);
    return tx;
  }

  function renderWallet(paneId){
    const p = $(paneId||'pane-wallet'); if(!p) return;
    const w = getWallet();
    p.innerHTML = `
    <div class="bkp-wallet-card">
      <div class="bkp-wc-label">SOKONI WALLET · ${w.tier}</div>
      <div class="bkp-wc-balance">KES ${fmt(w.balance)}</div>
      <div class="bkp-wc-sub">Available Balance · Limit KES ${fmt(w.dailyLimit)}/day</div>
      <div class="bkp-wc-actions">
        <button class="bkp-wa-btn" onclick="BankingPro.openWalletAction('deposit')">⬇️ Deposit</button>
        <button class="bkp-wa-btn" onclick="BankingPro.openWalletAction('withdraw')">⬆️ Withdraw</button>
        <button class="bkp-wa-btn" onclick="BankingPro.openWalletAction('transfer')">↔️ Transfer</button>
        <button class="bkp-wa-btn" onclick="BankingPro.renderWalletHistory()">📋 History</button>
      </div>
    </div>
    <div class="bkp-section-h">⚡ Quick Deposit</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
      ${[100,250,500,1000,2500,5000].map(a=>`<button class="bkp-quick-amt" onclick="BankingPro.quickDeposit(${a})">+KES ${fmt(a)}</button>`).join('')}
    </div>
    <div id="bkp-wallet-history"></div>
    <div class="bkp-notif-modal" id="bkpWalletModal">
      <div class="bkp-modal-box">
        <button class="bkp-modal-close" onclick="BankingPro.closeWalletModal()">✕</button>
        <div id="bkpWalletModalBody"></div>
      </div>
    </div>`;
    renderWalletHistory('bkp-wallet-history');
  }

  function renderWalletHistory(containerId){
    const el = $(containerId||'bkp-wallet-history'); if(!el) return;
    const w = getWallet();
    const txs = (w.transactions||[]).slice(0,30);
    if(!txs.length){ el.innerHTML=`<div class="bkp-empty">No transactions yet. Deposit to get started.</div>`; return; }
    el.innerHTML = `<div class="bkp-section-h">📋 Recent Transactions</div>` +
      txs.map(t=>`
      <div class="bkp-tx-row">
        <div class="bkp-tx-icon ${t.type==='credit'?'credit':'debit'}">${t.type==='credit'?'⬇️':'⬆️'}</div>
        <div class="bkp-tx-info"><div class="bkp-tx-desc">${_esc(t.desc)}</div><div class="bkp-tx-ts">${new Date(t.ts).toLocaleString()}</div></div>
        <div class="bkp-tx-amt ${t.type==='credit'?'credit':'debit'}">${t.type==='credit'?'+':'-'}KES ${fmt(t.amount)}</div>
      </div>`).join('');
  }

  function openWalletAction(type){
    const modal = $('bkpWalletModal'); if(!modal) return;
    const body  = $('bkpWalletModalBody'); if(!body) return;
    const labels = { deposit:'Deposit to Wallet', withdraw:'Withdraw from Wallet', transfer:'Transfer Funds' };
    body.innerHTML = `
    <h3 class="bkp-modal-title">${labels[type]||type}</h3>
    <input class="modal-input" type="number" id="bkpWalletAmt" placeholder="Amount (KES) *" min="50" style="margin-top:10px;">
    ${type==='transfer'?`<input class="modal-input" type="tel" id="bkpWalletRecipient" placeholder="Recipient Phone or ID *">`:''}
    <input class="modal-input" type="text" id="bkpWalletRef" placeholder="Reference / Note">
    ${type==='deposit'?`<div style="font-size:11px;color:rgba(255,255,255,0.4);margin:8px 0 14px;">Send via M-Pesa Paybill <strong style="color:#f59e0b;">SOKONI</strong> then click confirm.</div>`:''}
    <button class="modal-submit" onclick="BankingPro.submitWalletAction('${type}')">✅ Confirm ${labels[type]||type}</button>
    <div id="bkpWalletMsg" style="margin-top:10px;font-size:12px;min-height:16px;text-align:center;"></div>`;
    modal.classList.add('open');
  }

  function closeWalletModal(){ const m=$('bkpWalletModal'); if(m) m.classList.remove('open'); }

  function submitWalletAction(type){
    if(window.SokoniSecurity?.persistentRateLimit && !SokoniSecurity.persistentRateLimit('wallet_tx',10,60000)){
      (window._skToast||alert)('Too many transactions. Wait 1 minute.'); return;
    }
    const amt   = Number($('bkpWalletAmt')?.value)||0;
    const ref   = $('bkpWalletRef')?.value.trim()||'';
    const recip = $('bkpWalletRecipient')?.value.trim()||'';
    const msgEl = $('bkpWalletMsg');
    if(!amt||amt<50){ if(msgEl){msgEl.textContent='⚠️ Minimum KES 50'; msgEl.style.color='#f59e0b';} return; }
    const w = getWallet();
    if(type!=='deposit' && amt>w.balance){ if(msgEl){msgEl.textContent='⚠️ Insufficient balance'; msgEl.style.color='#ff6b6b';} return; }
    if(type!=='deposit' && amt>w.dailyLimit){ if(msgEl){msgEl.textContent='⚠️ Exceeds daily limit KES '+fmt(w.dailyLimit); msgEl.style.color='#ff6b6b';} return; }

    const desc = type==='deposit'?`M-Pesa Deposit${ref?' · '+ref:''}`:
                 type==='withdraw'?`Withdrawal${ref?' · '+ref:''}`:
                 `Transfer to ${recip}${ref?' · '+ref:''}`;
    walletTx(type==='deposit'?'credit':'debit', amt, desc);
    fsWrite('wallet_transactions',{uid:uid(),type,amount:amt,desc,ref,recip,ts:ts()});
    if(msgEl){msgEl.innerHTML=`✅ ${type==='deposit'?'Deposited':'Sent'}: KES ${fmt(amt)}`;msgEl.style.color='#10b981';}
    setTimeout(()=>{ closeWalletModal(); renderWalletHistory('bkp-wallet-history'); renderWalletCard(); }, 1500);
  }

  function quickDeposit(amt){
    const w=getWallet();
    walletTx('credit',amt,'Quick Demo Deposit');
    fsWrite('wallet_transactions',{uid:uid(),type:'credit',amount:amt,desc:'Quick Demo Deposit',ts:ts()});
    renderWalletCard();
    renderWalletHistory('bkp-wallet-history');
  }

  function renderWalletCard(){
    const el = document.querySelector('.bkp-wc-balance');
    if(el) el.textContent = 'KES '+fmt(getWallet().balance);
  }

  /* ── FINANCIAL DASHBOARD ── */
  function renderFinancialDashboard(paneId){
    const p=$(paneId||'pane-dashboard'); if(!p) return;
    const w=getWallet();
    const txs=w.transactions||[];
    const credits=txs.filter(t=>t.type==='credit').reduce((s,t)=>s+t.amount,0);
    const debits =txs.filter(t=>t.type==='debit' ).reduce((s,t)=>s+t.amount,0);
    const loans  =lsArr('bkpro_loan_applications').filter(a=>a.uid===uid());
    const invoices=lsArr('sokoni_invoices').filter(i=>i.uid===uid());
    const invPaid=invoices.filter(i=>i.status==='paid').reduce((s,i)=>s+Number(i.amount||0),0);
    const invPend=invoices.filter(i=>i.status==='pending').reduce((s,i)=>s+Number(i.amount||0),0);

    p.innerHTML = `
    <div class="bkp-dash-grid">
      <div class="bkp-stat-card" style="border-color:rgba(245,158,11,0.3);">
        <div class="bkp-sc-icon">💰</div>
        <div class="bkp-sc-val" style="color:#f59e0b;">KES ${fmt(w.balance)}</div>
        <div class="bkp-sc-lbl">Wallet Balance</div>
      </div>
      <div class="bkp-stat-card" style="border-color:rgba(16,185,129,0.3);">
        <div class="bkp-sc-icon">⬇️</div>
        <div class="bkp-sc-val" style="color:#10b981;">KES ${fmt(credits)}</div>
        <div class="bkp-sc-lbl">Total Received</div>
      </div>
      <div class="bkp-stat-card" style="border-color:rgba(239,68,68,0.3);">
        <div class="bkp-sc-icon">⬆️</div>
        <div class="bkp-sc-val" style="color:#ef4444;">KES ${fmt(debits)}</div>
        <div class="bkp-sc-lbl">Total Sent</div>
      </div>
      <div class="bkp-stat-card" style="border-color:rgba(59,130,246,0.3);">
        <div class="bkp-sc-icon">📜</div>
        <div class="bkp-sc-val" style="color:#60aaff;">KES ${fmt(invPaid)}</div>
        <div class="bkp-sc-lbl">Invoices Collected</div>
      </div>
      <div class="bkp-stat-card" style="border-color:rgba(168,85,247,0.3);">
        <div class="bkp-sc-icon">⏳</div>
        <div class="bkp-sc-val" style="color:#a855f7;">KES ${fmt(invPend)}</div>
        <div class="bkp-sc-lbl">Invoices Pending</div>
      </div>
      <div class="bkp-stat-card" style="border-color:rgba(249,115,22,0.3);">
        <div class="bkp-sc-icon">🏦</div>
        <div class="bkp-sc-val" style="color:#f97316;">${loans.length}</div>
        <div class="bkp-sc-lbl">Loan Applications</div>
      </div>
    </div>

    <div class="bkp-section-h" style="margin-top:28px;">📊 Spending Breakdown</div>
    <div id="bkp-spend-chart"></div>

    <div class="bkp-section-h" style="margin-top:24px;">📋 Recent Activity</div>
    <div id="bkp-dash-activity"></div>`;

    renderSpendChart('bkp-spend-chart', txs);
    renderDashActivity('bkp-dash-activity', txs.slice(0,10));
  }

  function renderSpendChart(containerId, txs){
    const el=$(containerId); if(!el) return;
    const cats=['Deposit','Withdrawal','Transfer','Invoice','Loan'];
    const data = cats.map(c=>({ cat:c, total:txs.filter(t=>t.desc&&t.desc.toLowerCase().includes(c.toLowerCase())).reduce((s,t)=>s+t.amount,0) }));
    const max = Math.max(...data.map(d=>d.total),1);
    el.innerHTML=`<div class="bkp-bar-chart">${data.map(d=>`
    <div class="bkp-bar-row">
      <div class="bkp-bar-lbl">${d.cat}</div>
      <div class="bkp-bar-track"><div class="bkp-bar-fill" style="width:${Math.round(d.total/max*100)}%;"></div></div>
      <div class="bkp-bar-val">${fmtK(d.total)}</div>
    </div>`).join('')}</div>`;
  }

  function renderDashActivity(containerId, txs){
    const el=$(containerId); if(!el) return;
    if(!txs.length){ el.innerHTML=`<div class="bkp-empty">No activity yet.</div>`; return; }
    el.innerHTML=txs.map(t=>`
    <div class="bkp-tx-row">
      <div class="bkp-tx-icon ${t.type==='credit'?'credit':'debit'}">${t.type==='credit'?'⬇️':'⬆️'}</div>
      <div class="bkp-tx-info"><div class="bkp-tx-desc">${_esc(t.desc)}</div><div class="bkp-tx-ts">${new Date(t.ts).toLocaleString()}</div></div>
      <div class="bkp-tx-amt ${t.type==='credit'?'credit':'debit'}">${t.type==='credit'?'+':'-'}KES ${fmt(t.amount)}</div>
    </div>`).join('');
  }

  /* ── BNPL ── */
  const BNPL_PLANS = [
    { id:'bnpl3', name:'3-Month Plan', months:3, rate:0, desc:'Split into 3 equal payments. 0% interest. Perfect for purchases under KES 30,000.', maxAmount:30000 },
    { id:'bnpl6', name:'6-Month Plan', months:6, rate:5, desc:'6 equal monthly payments. 5% total fee. For purchases KES 10,000–100,000.', maxAmount:100000 },
    { id:'bnpl12', name:'12-Month Plan', months:12, rate:10, desc:'12 monthly installments. 10% total fee. For large purchases up to KES 300,000.', maxAmount:300000 },
    { id:'bnpl24', name:'24-Month Plan', months:24, rate:18, desc:'Extended financing for big-ticket items. 18% total fee over 24 months. Up to KES 500,000.', maxAmount:500000 },
  ];

  function renderBNPL(paneId){
    const p=$(paneId||'pane-bnpl'); if(!p) return;
    p.innerHTML = `
    <div class="bkp-section-h">🛒 Buy Now, Pay Later — How It Works</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:28px;">
      ${['Choose product','Select BNPL plan','Approve in 60s','Get product now','Pay monthly'].map((s,i)=>`
      <div class="bkp-bnpl-step">
        <div class="bkp-step-num" style="background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.3);color:#f59e0b;">${i+1}</div>
        <div style="font-size:12px;font-weight:700;color:white;">${s}</div>
      </div>`).join('')}
    </div>

    <div class="bkp-section-h">💳 BNPL Plans</div>
    <div class="bkp-bnpl-grid">
      ${BNPL_PLANS.map(plan=>`
      <div class="bkp-bnpl-card" onclick="BankingPro.openBNPLApplication('${plan.id}')">
        <div class="bkp-bnpl-name">${plan.name}</div>
        <div class="bkp-bnpl-rate" style="color:${plan.rate===0?'#10b981':'#f59e0b'};">${plan.rate===0?'0% Interest':''+plan.rate+'% fee'}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.4);margin:6px 0;">Up to KES ${fmt(plan.maxAmount)}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.5);line-height:1.5;">${plan.desc}</div>
        <button class="bkp-apply-btn" style="margin-top:12px;">🛒 Apply Now</button>
      </div>`).join('')}
    </div>

    <div class="bkp-section-h" style="margin-top:28px;">🧮 BNPL Calculator</div>
    <div class="bkp-calc-box">
      <div class="calc-grid">
        <div class="calc-input-group"><label>Item Price (KES)</label>
          <input class="calc-input" type="number" id="bnplCalcAmt" placeholder="25000" value="25000" oninput="BankingPro.calcBNPL()">
        </div>
        <div class="calc-input-group"><label>Plan</label>
          <select class="calc-input" id="bnplCalcPlan" onchange="BankingPro.calcBNPL()">
            ${BNPL_PLANS.map(p=>`<option value="${p.id}">${p.name} (${p.rate}% fee)</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="bnplCalcResult"></div>
    </div>

    <div class="bkp-section-h" style="margin-top:28px;">📋 Your BNPL Plans</div>
    <div id="bkp-active-bnpl"></div>`;

    calcBNPL();
    renderActiveBNPL('bkp-active-bnpl');
  }

  function calcBNPL(){
    const amt   = Number($('bnplCalcAmt')?.value)||0;
    const planId= $('bnplCalcPlan')?.value||'bnpl3';
    const plan  = BNPL_PLANS.find(p=>p.id===planId)||BNPL_PLANS[0];
    const el    = $('bnplCalcResult'); if(!el) return;
    if(!amt){ el.innerHTML=''; return; }
    const total   = amt * (1 + plan.rate/100);
    const monthly = total / plan.months;
    el.innerHTML=`
    <div class="calc-result">
      <div class="calc-result-box"><div class="calc-result-val">KES ${fmt(Math.round(monthly))}</div><div class="calc-result-lbl">Monthly Payment</div></div>
      <div class="calc-result-box"><div class="calc-result-val">KES ${fmt(Math.round(total))}</div><div class="calc-result-lbl">Total to Pay</div></div>
      <div class="calc-result-box"><div class="calc-result-val" style="color:#ff6b6b;">KES ${fmt(Math.round(total-amt))}</div><div class="calc-result-lbl">Fee/Interest</div></div>
      <div class="calc-result-box"><div class="calc-result-val" style="color:rgba(255,255,255,0.6);">${plan.months} months</div><div class="calc-result-lbl">Duration</div></div>
    </div>`;
  }

  function openBNPLApplication(planId){
    const plan = BNPL_PLANS.find(p=>p.id===planId)||BNPL_PLANS[0];
    openBkpModal('🛒 BNPL Application — '+plan.name, `
    <input class="modal-input" type="text" id="bkpBnplItem" placeholder="Item / Product Name *">
    <input class="modal-input" type="number" id="bkpBnplAmt" placeholder="Item Price (KES) *" max="${plan.maxAmount}">
    <input class="modal-input" type="text" id="bkpBnplSeller" placeholder="Seller / Store Name *">
    <input class="modal-input" type="text" id="bkpBnplName" placeholder="Your Full Name *">
    <input class="modal-input" type="tel" id="bkpBnplPhone" placeholder="Phone Number *">
    <input class="modal-input" type="email" id="bkpBnplEmail" placeholder="Email Address">
    <div style="font-size:11px;color:rgba(255,255,255,0.4);margin:4px 0 12px;">Plan: <strong style="color:#f59e0b;">${plan.name}</strong> · Fee: ${plan.rate}% · Max: KES ${fmt(plan.maxAmount)}</div>
    <button class="modal-submit" onclick="BankingPro.submitBNPLApplication('${planId}')">🛒 Submit BNPL Application</button>
    <div id="bkpBkModal-msg" style="margin-top:10px;font-size:12px;min-height:16px;text-align:center;"></div>`);
  }

  function submitBNPLApplication(planId){
    if(window.SokoniSecurity?.persistentRateLimit && !SokoniSecurity.persistentRateLimit('bnpl_apply',3,300000)){
      (window._skToast||alert)('Too many applications. Wait 5 minutes.'); return;
    }
    const plan   = BNPL_PLANS.find(p=>p.id===planId)||BNPL_PLANS[0];
    const item   = $('bkpBnplItem')?.value.trim();
    const amt    = Number($('bkpBnplAmt')?.value)||0;
    const seller = $('bkpBnplSeller')?.value.trim();
    const name   = $('bkpBnplName')?.value.trim();
    const phone  = $('bkpBnplPhone')?.value.trim();
    const email  = $('bkpBnplEmail')?.value.trim();
    const msgEl  = $('bkpBkModal-msg');
    if(!item||!amt||!seller||!name||!phone){ if(msgEl){msgEl.textContent='⚠️ Fill all required fields';msgEl.style.color='#f59e0b';} return; }
    if(amt>plan.maxAmount){ if(msgEl){msgEl.textContent='⚠️ Amount exceeds plan limit KES '+fmt(plan.maxAmount);msgEl.style.color='#ff6b6b';} return; }
    const app = { id:'BNPL'+ts(), uid:uid(), planId, planName:plan.name, item, amount:amt, seller, name, phone, email,
                  monthlyPayment:Math.round(amt*(1+plan.rate/100)/plan.months), months:plan.months, paidMonths:0,
                  status:'pending_review', createdAt:ts() };
    const arr=lsArr('sokoni_bnpl'); arr.unshift(app); lsSet('sokoni_bnpl',arr);
    fsWrite('bnpl_applications', app);
    addNotification('payments','BNPL Application Received',`${plan.name} for ${item} — KES ${fmt(amt)} submitted.`);
    if(msgEl){msgEl.innerHTML='✅ Application submitted! We\'ll review within 24hrs.';msgEl.style.color='#10b981';}
    setTimeout(()=>{ closeBkpModal(); renderActiveBNPL('bkp-active-bnpl'); }, 2000);
  }

  function renderActiveBNPL(containerId){
    const el=$(containerId); if(!el) return;
    const plans=lsArr('sokoni_bnpl').filter(a=>a.uid===uid());
    if(!plans.length){ el.innerHTML=`<div class="bkp-empty">No BNPL plans yet. Apply above to get started.</div>`; return; }
    el.innerHTML=plans.map(p=>`
    <div class="bkp-invoice-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:13px;font-weight:800;color:white;">${p.item}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">${p.planName} · ${p.seller}</div>
        </div>
        <span class="bkp-status-badge ${p.status==='active'?'active':p.status==='completed'?'paid':'pending'}">${p.status}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px;">
        <div class="bkp-mini-stat"><div class="bkp-ms-val">KES ${fmt(p.amount)}</div><div class="bkp-ms-lbl">Item Price</div></div>
        <div class="bkp-mini-stat"><div class="bkp-ms-val">KES ${fmt(p.monthlyPayment)}</div><div class="bkp-ms-lbl">Monthly</div></div>
        <div class="bkp-mini-stat"><div class="bkp-ms-val">${p.paidMonths||0}/${p.months}</div><div class="bkp-ms-lbl">Paid</div></div>
      </div>
    </div>`).join('');
  }

  /* ── MERCHANT FINANCE ── */
  const MERCHANT_PRODUCTS = [
    { id:'inventory', name:'Inventory Finance', icon:'📦', desc:'Fund your stock without draining cash. Get up to KES 500K for inventory against your Sokoni sales history.', rate:'2.5% per month', max:'KES 500,000', tenure:'1–6 months' },
    { id:'working_capital', name:'Working Capital', icon:'⚙️', desc:'Keep operations running. Quick cash injection for day-to-day business costs. No collateral for active sellers.', rate:'2% per month', max:'KES 300,000', tenure:'1–3 months' },
    { id:'seller_financing', name:'Seller Growth Loan', icon:'📈', desc:'Scale your Sokoni shop. Finance for equipment, staff, marketing or expansion for verified sellers.', rate:'1.8% per month', max:'KES 1,000,000', tenure:'3–24 months' },
    { id:'invoice_advance', name:'Invoice Advance', icon:'📜', desc:'Get paid before your buyer pays. Upload unpaid invoices and receive up to 80% upfront within 24 hours.', rate:'3% per invoice', max:'KES 2,000,000', tenure:'30–90 days' },
  ];

  function renderMerchantFinance(paneId){
    const p=$(paneId||'pane-merchant'); if(!p) return;
    p.innerHTML = `
    <div class="alert-banner" style="background:rgba(245,158,11,0.07);border-color:rgba(245,158,11,0.2);">
      <div class="alert-icon">🏪</div>
      <div class="alert-info">
        <h3>🏪 Finance built for Sokoni sellers</h3>
        <p>Access funding based on your actual sales history — no bank statements, no collateral. Active sellers with 3+ months on Sokoni qualify immediately.</p>
      </div>
    </div>
    <div class="bkp-section-h">💼 Merchant Finance Products</div>
    <div class="bank-grid">
      ${MERCHANT_PRODUCTS.map(mp=>`
      <div class="bank-card" style="border-color:rgba(245,158,11,0.18);">
        <div class="bank-card-top">
          <div class="bank-logo-circle" style="background:rgba(245,158,11,0.1);font-size:26px;">${mp.icon}</div>
          <div><div class="bank-name">${mp.name}</div><div class="bank-type" style="color:#f59e0b;">Rate: ${mp.rate}</div></div>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:10px;line-height:1.5;">${mp.desc}</div>
        <div class="bank-features">
          <span class="bank-tag">Max: ${mp.max}</span>
          <span class="bank-tag">Tenure: ${mp.tenure}</span>
        </div>
        <button class="bank-apply-btn" style="margin-top:10px;" onclick="BankingPro.openMerchantRequest('${mp.id}')">💼 Apply Now →</button>
      </div>`).join('')}
    </div>
    <div class="bkp-section-h" style="margin-top:28px;">📋 Your Applications</div>
    <div id="bkp-merchant-apps"></div>`;
    renderMerchantApps('bkp-merchant-apps');
  }

  function openMerchantRequest(productId){
    const mp=MERCHANT_PRODUCTS.find(p=>p.id===productId)||MERCHANT_PRODUCTS[0];
    openBkpModal('💼 '+mp.name+' Application', `
    <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:14px;">Max: ${mp.max} · Rate: ${mp.rate} · Tenure: ${mp.tenure}</div>
    <input class="modal-input" type="text" id="bkpMchName" placeholder="Full Name / Business Name *">
    <input class="modal-input" type="tel" id="bkpMchPhone" placeholder="Phone Number *">
    <input class="modal-input" type="number" id="bkpMchAmt" placeholder="Amount Needed (KES) *">
    <input class="modal-input" type="text" id="bkpMchShop" placeholder="Sokoni Shop Name *">
    <textarea class="modal-input" id="bkpMchPurpose" placeholder="Purpose / How you'll use it *" style="min-height:60px;resize:vertical;"></textarea>
    <button class="modal-submit" onclick="BankingPro.submitMerchantRequest('${productId}')">💼 Submit Application</button>
    <div id="bkpBkModal-msg" style="margin-top:10px;font-size:12px;min-height:16px;text-align:center;"></div>`);
  }

  function submitMerchantRequest(productId){
    if(window.SokoniSecurity?.persistentRateLimit && !SokoniSecurity.persistentRateLimit('merchant_fin',3,300000)){
      (window._skToast||alert)('Too many applications. Wait 5 minutes.'); return;
    }
    const mp   =MERCHANT_PRODUCTS.find(p=>p.id===productId)||MERCHANT_PRODUCTS[0];
    const name = $('bkpMchName')?.value.trim();
    const phone= $('bkpMchPhone')?.value.trim();
    const amt  = Number($('bkpMchAmt')?.value)||0;
    const shop = $('bkpMchShop')?.value.trim();
    const why  = $('bkpMchPurpose')?.value.trim();
    const msgEl= $('bkpBkModal-msg');
    if(!name||!phone||!amt||!shop||!why){ if(msgEl){msgEl.textContent='⚠️ Fill all required fields';msgEl.style.color='#f59e0b';} return; }
    const app={id:'MCH'+ts(),uid:uid(),productId,productName:mp.name,name,phone,amount:amt,shop,purpose:why,status:'submitted',createdAt:ts()};
    const arr=lsArr('bkpro_merchant'); arr.unshift(app); lsSet('bkpro_merchant',arr);
    fsWrite('merchant_finance',app);
    addNotification('payments','Merchant Finance Applied',`${mp.name} — KES ${fmt(amt)} submitted.`);
    if(msgEl){msgEl.innerHTML='✅ Application submitted! Response within 24 hours.';msgEl.style.color='#10b981';}
    setTimeout(()=>{ closeBkpModal(); renderMerchantApps('bkp-merchant-apps'); }, 2000);
  }

  function renderMerchantApps(containerId){
    const el=$(containerId); if(!el) return;
    const apps=lsArr('bkpro_merchant').filter(a=>a.uid===uid());
    if(!apps.length){ el.innerHTML=`<div class="bkp-empty">No merchant finance applications yet.</div>`; return; }
    el.innerHTML=apps.map(a=>`
    <div class="bkp-invoice-card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><div style="font-size:13px;font-weight:800;color:white;">${a.productName}</div><div style="font-size:11px;color:rgba(255,255,255,0.4);">${a.shop} · KES ${fmt(a.amount)}</div></div>
        <span class="bkp-status-badge pending">${a.status}</span>
      </div>
    </div>`).join('');
  }

  /* ── INVOICING ── */
  function getInvoices(){ return lsArr('sokoni_invoices').filter(i=>i.uid===uid()); }
  function saveInvoices(all){ lsSet('sokoni_invoices',all); }

  function renderInvoices(paneId){
    const p=$(paneId||'pane-invoices'); if(!p) return;
    p.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px;">
      <div class="bkp-section-h" style="margin:0;">📜 Invoices</div>
      <button class="bkp-primary-btn" onclick="BankingPro.openCreateInvoice()">+ New Invoice</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      ${['all','pending','paid','overdue'].map(s=>`<button class="bk-tab ${s==='all'?'active':''}" id="inv-filter-${s}" onclick="BankingPro.filterInvoices('${s}')">${s.charAt(0).toUpperCase()+s.slice(1)}</button>`).join('')}
    </div>
    <div id="bkp-invoice-list"></div>`;
    filterInvoices('all');
  }

  function filterInvoices(status){
    ['all','pending','paid','overdue'].forEach(s=>{const b=$('inv-filter-'+s);if(b)b.classList.toggle('active',s===status);});
    renderInvoiceList('bkp-invoice-list',status);
  }

  function renderInvoiceList(containerId, statusFilter){
    const el=$(containerId); if(!el) return;
    let invs=getInvoices();
    if(statusFilter&&statusFilter!=='all') invs=invs.filter(i=>i.status===statusFilter);
    if(!invs.length){ el.innerHTML=`<div class="bkp-empty">No invoices${statusFilter&&statusFilter!=='all'?' with status '+statusFilter:''}.</div>`; return; }
    el.innerHTML=invs.map(inv=>`
    <div class="bkp-invoice-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:14px;font-weight:800;color:white;">#${inv.number} — ${inv.clientName}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">${inv.desc} · Due: ${inv.dueDate||'—'}</div>
        </div>
        <span class="bkp-status-badge ${inv.status}">${inv.status}</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:8px;">
        <div style="font-size:18px;font-weight:900;color:#f59e0b;">KES ${fmt(inv.amount)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${inv.status!=='paid'?`<button class="bkp-mini-btn green" onclick="BankingPro.markInvoicePaid('${inv.id}')">✅ Mark Paid</button>`:''}
          <button class="bkp-mini-btn" onclick="BankingPro.sendInvoiceWA('${inv.id}')">📲 WhatsApp</button>
          <button class="bkp-mini-btn red" onclick="BankingPro.deleteInvoice('${inv.id}')">🗑️</button>
        </div>
      </div>
    </div>`).join('');
  }

  let _invoiceNum = lsGet('sokoni_inv_num')||1000;

  function openCreateInvoice(){
    _invoiceNum = (lsGet('sokoni_inv_num')||1000) + 1;
    lsSet('sokoni_inv_num', _invoiceNum);
    openBkpModal('📜 Create Invoice', `
    <div class="g2">
      <div><label style="font-size:10px;color:rgba(255,255,255,0.4);display:block;margin-bottom:4px;">Invoice #</label>
        <input class="modal-input" type="text" id="bkpInvNum" value="INV-${_invoiceNum}" readonly style="color:#f59e0b;"></div>
      <div><label style="font-size:10px;color:rgba(255,255,255,0.4);display:block;margin-bottom:4px;">Due Date</label>
        <input class="modal-input" type="date" id="bkpInvDue"></div>
    </div>
    <input class="modal-input" type="text" id="bkpInvClient" placeholder="Client Name *">
    <input class="modal-input" type="tel" id="bkpInvPhone" placeholder="Client Phone *">
    <input class="modal-input" type="text" id="bkpInvDesc" placeholder="Service / Product Description *">
    <input class="modal-input" type="number" id="bkpInvAmt" placeholder="Amount (KES) *">
    <textarea class="modal-input" id="bkpInvNotes" placeholder="Additional notes (optional)" style="min-height:50px;resize:vertical;"></textarea>
    <button class="modal-submit" onclick="BankingPro.submitInvoice()">📜 Create Invoice</button>
    <div id="bkpBkModal-msg" style="margin-top:10px;font-size:12px;min-height:16px;text-align:center;"></div>`);
    const due=$('bkpInvDue'); if(due){ const d=new Date(); d.setDate(d.getDate()+14); due.value=d.toISOString().split('T')[0]; }
  }

  function submitInvoice(){
    const num  =$('bkpInvNum')?.value.trim();
    const due  =$('bkpInvDue')?.value;
    const client=$('bkpInvClient')?.value.trim();
    const phone=$('bkpInvPhone')?.value.trim();
    const desc =$('bkpInvDesc')?.value.trim();
    const amt  =Number($('bkpInvAmt')?.value)||0;
    const notes=$('bkpInvNotes')?.value.trim();
    const msgEl=$('bkpBkModal-msg');
    if(!client||!phone||!desc||!amt){ if(msgEl){msgEl.textContent='⚠️ Fill all required fields';msgEl.style.color='#f59e0b';} return; }
    const inv={id:'INV'+ts(),uid:uid(),number:num,clientName:client,clientPhone:phone,desc,amount:amt,notes,dueDate:due,status:'pending',createdAt:ts()};
    const all=lsArr('sokoni_invoices'); all.unshift(inv); lsSet('sokoni_invoices',all);
    fsWrite('invoices',inv);
    addNotification('payments','Invoice Created',`#${num} for ${client} — KES ${fmt(amt)}`);
    if(msgEl){msgEl.innerHTML='✅ Invoice #'+num+' created!';msgEl.style.color='#10b981';}
    setTimeout(()=>{ closeBkpModal(); filterInvoices('all'); }, 1500);
  }

  function markInvoicePaid(id){
    const all=lsArr('sokoni_invoices');
    const inv=all.find(i=>i.id===id); if(!inv) return;
    inv.status='paid'; inv.paidAt=ts();
    lsSet('sokoni_invoices',all);
    walletTx('credit',inv.amount,`Invoice #${inv.number} — ${inv.clientName}`);
    addNotification('payments','Invoice Paid',`#${inv.number} from ${inv.clientName} — KES ${fmt(inv.amount)}`);
    filterInvoices('all');
  }

  function sendInvoiceWA(id){
    const all=lsArr('sokoni_invoices');
    const inv=all.find(i=>i.id===id); if(!inv) return;
    const msg=encodeURIComponent(`Hi ${inv.clientName},\n\nThis is a payment reminder from SOKONI.\n\n📜 Invoice: #${inv.number}\n💰 Amount: KES ${fmt(inv.amount)}\n📅 Due: ${inv.dueDate||'Immediately'}\n📋 For: ${inv.desc}\n\nPlease make payment at your earliest convenience.\n\nThank you!\nSOKONI Business`);
    const phone=inv.clientPhone.replace(/\D/g,'');
    window.open(`https://wa.me/${phone.startsWith('0')?'254'+phone.slice(1):phone}?text=${msg}`,'_blank');
  }

  function deleteInvoice(id){
    if(!_c){_skConfirm('Delete this invoice?',()=>_doBankDelInvoice(_iid,true));return;}
    const all=lsArr('sokoni_invoices').filter(i=>i.id!==id);
    lsSet('sokoni_invoices',all);
    filterInvoices('all');
  }

  /* ── PAYMENT HISTORY ── */
  function renderPaymentHistory(paneId){
    const p=$(paneId||'pane-payments'); if(!p) return;
    const apps=JSON.parse(localStorage.getItem('sokoniBankApplications')||'[]');
    const bnpl=lsArr('sokoni_bnpl').filter(a=>a.uid===uid());
    const loans=lsArr('bkpro_loan_applications').filter(a=>a.uid===uid());
    const wallet=getWallet().transactions||[];

    p.innerHTML = `
    <div class="bkp-section-h">💳 Payment & Transaction History</div>
    <div class="bkp-dash-grid" style="margin-bottom:24px;">
      <div class="bkp-stat-card"><div class="bkp-sc-icon">💳</div><div class="bkp-sc-val">${apps.length}</div><div class="bkp-sc-lbl">Bank Applications</div></div>
      <div class="bkp-stat-card"><div class="bkp-sc-icon">🛒</div><div class="bkp-sc-val">${bnpl.length}</div><div class="bkp-sc-lbl">BNPL Plans</div></div>
      <div class="bkp-stat-card"><div class="bkp-sc-icon">🏦</div><div class="bkp-sc-val">${loans.length}</div><div class="bkp-sc-lbl">Loan Applications</div></div>
      <div class="bkp-stat-card"><div class="bkp-sc-icon">💰</div><div class="bkp-sc-val">${wallet.length}</div><div class="bkp-sc-lbl">Wallet Transactions</div></div>
    </div>

    <div class="bkp-section-h">📋 Bank Applications</div>
    ${apps.length?apps.slice(0,10).map(a=>`
    <div class="bkp-invoice-card">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div><div style="font-size:13px;font-weight:800;color:white;">${a.product}</div><div style="font-size:11px;color:rgba(255,255,255,0.4);">${a.bank} · ${a.purpose||'—'}</div></div>
        <span class="bkp-status-badge pending">KES ${fmt(a.amount)}</span>
      </div>
    </div>`).join(''):`<div class="bkp-empty">No bank applications yet.</div>`}

    <div class="bkp-section-h" style="margin-top:24px;">💰 Wallet Transactions</div>
    ${wallet.length?wallet.slice(0,20).map(t=>`
    <div class="bkp-tx-row">
      <div class="bkp-tx-icon ${t.type==='credit'?'credit':'debit'}">${t.type==='credit'?'⬇️':'⬆️'}</div>
      <div class="bkp-tx-info"><div class="bkp-tx-desc">${_esc(t.desc)}</div><div class="bkp-tx-ts">${new Date(t.ts).toLocaleString()}</div></div>
      <div class="bkp-tx-amt ${t.type==='credit'?'credit':'debit'}">${t.type==='credit'?'+':'-'}KES ${fmt(t.amount)}</div>
    </div>`).join(''):`<div class="bkp-empty">No wallet transactions yet.</div>`}`;
  }

  /* ── NOTIFICATIONS ── */
  const NOTIF_KEY='bkp_notifications';
  function addNotification(category, title, body){
    const notifs=lsArr(NOTIF_KEY);
    notifs.unshift({id:'N'+ts(),category,title,body,read:false,ts:ts()});
    lsSet(NOTIF_KEY,notifs.slice(0,100));
    updateNotifBadge();
  }
  function getNotifications(){ return lsArr(NOTIF_KEY); }
  function markNotifRead(id){
    const notifs=lsArr(NOTIF_KEY);
    const n=notifs.find(n=>n.id===id); if(n) n.read=true;
    lsSet(NOTIF_KEY,notifs);
    renderNotifications('bkp-notif-list');
    updateNotifBadge();
  }
  function markAllRead(){
    const notifs=lsArr(NOTIF_KEY).map(n=>({...n,read:true}));
    lsSet(NOTIF_KEY,notifs);
    renderNotifications('bkp-notif-list');
    updateNotifBadge();
  }
  function updateNotifBadge(){
    const count=lsArr(NOTIF_KEY).filter(n=>!n.read).length;
    const badge=$('bkp-notif-count');
    if(badge){ badge.textContent=count||''; badge.style.display=count?'flex':'none'; }
  }
  function renderNotifications(containerId){
    const el=$(containerId||'bkp-notif-list'); if(!el) return;
    const notifs=getNotifications();
    if(!notifs.length){ el.innerHTML=`<div class="bkp-empty">No notifications.</div>`; return; }
    el.innerHTML=notifs.slice(0,40).map(n=>`
    <div class="bkp-notif-row ${n.read?'read':''}" onclick="BankingPro.markNotifRead('${n.id}')">
      <div class="bkp-notif-dot ${n.read?'':'unread'}"></div>
      <div class="bkp-notif-body">
        <div class="bkp-notif-title">${n.title}</div>
        <div class="bkp-notif-text">${n.body}</div>
        <div class="bkp-notif-time">${new Date(n.ts).toLocaleString()}</div>
      </div>
    </div>`).join('');
  }
  function renderNotifPanel(paneId){
    const p=$(paneId||'pane-notifs'); if(!p) return;
    p.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px;">
      <div class="bkp-section-h" style="margin:0;">🔔 Notifications <span id="bkp-notif-count" class="bkp-notif-badge"></span></div>
      <button class="bkp-mini-btn" onclick="BankingPro.markAllRead()">✅ Mark All Read</button>
    </div>
    <div id="bkp-notif-list"></div>`;
    renderNotifications('bkp-notif-list');
    updateNotifBadge();
  }

  /* ── ADMIN DASHBOARD ── */
  async function renderAdminDashboard(paneId){
    const p=$(paneId||'pane-admin'); if(!p) return;

    /* Claims arrive asynchronously; show a neutral state rather than flashing
       a denial at an administrator whose token simply has not resolved yet. */
    if(!_claimsLoaded){
      p.innerHTML=`<div class="bkp-empty" style="padding:60px 20px;"><div style="font-size:15px;color:rgba(255,255,255,0.55);">Checking access…</div></div>`;
    }

    const allowed = await ensureAdmin();
    if(!allowed){
      /* Not signed in is a different problem from not being an admin, and
         telling a signed-out user they lack privileges sends them hunting for
         the wrong fix. */
      const signedIn = !!_authUser();
      const title = signedIn ? 'Admin Access Required' : 'Sign In Required';
      const body  = signedIn
        ? 'This section is only available to Sokoni administrators.'
        : 'Sign in with an administrator account to view this section.';
      p.innerHTML=`<div class="bkp-empty" style="padding:60px 20px;"><div style="font-size:48px;margin-bottom:16px;">🔒</div><div style="font-size:15px;font-weight:800;color:white;margin-bottom:8px;">${_esc(title)}</div><div style="font-size:12px;color:rgba(255,255,255,0.4);">${_esc(body)}</div></div>`;
      return;
    }
    const allApps   = JSON.parse(localStorage.getItem('sokoniBankApplications')||'[]');
    const allBnpl   = lsArr('sokoni_bnpl');
    const allMch    = lsArr('bkpro_merchant');
    const allInvs   = lsArr('sokoni_invoices');
    const allWallet = lsArr('bkpro_wallet_transactions');
    const totalLoans= allApps.reduce((s,a)=>s+Number(a.amount||0),0);
    const paidInvs  = allInvs.filter(i=>i.status==='paid').reduce((s,i)=>s+Number(i.amount||0),0);

    p.innerHTML=`
    <div class="bkp-section-h">🛡️ Admin Finance Dashboard</div>
    <div class="bkp-dash-grid">
      <div class="bkp-stat-card admin"><div class="bkp-sc-icon">🏦</div><div class="bkp-sc-val">${allApps.length}</div><div class="bkp-sc-lbl">Loan Applications</div></div>
      <div class="bkp-stat-card admin"><div class="bkp-sc-icon">💰</div><div class="bkp-sc-val">${fmtK(totalLoans)}</div><div class="bkp-sc-lbl">Total Requested</div></div>
      <div class="bkp-stat-card admin"><div class="bkp-sc-icon">🛒</div><div class="bkp-sc-val">${allBnpl.length}</div><div class="bkp-sc-lbl">BNPL Plans</div></div>
      <div class="bkp-stat-card admin"><div class="bkp-sc-icon">📜</div><div class="bkp-sc-val">${fmtK(paidInvs)}</div><div class="bkp-sc-lbl">Invoices Paid</div></div>
      <div class="bkp-stat-card admin"><div class="bkp-sc-icon">💼</div><div class="bkp-sc-val">${allMch.length}</div><div class="bkp-sc-lbl">Merchant Finance</div></div>
      <div class="bkp-stat-card admin"><div class="bkp-sc-icon">💳</div><div class="bkp-sc-val">${allWallet.length}</div><div class="bkp-sc-lbl">Wallet Txns</div></div>
    </div>

    <div class="bkp-section-h" style="margin-top:24px;">📋 Recent Loan Applications</div>
    ${allApps.slice(0,15).map(a=>`
    <div class="bkp-invoice-card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:13px;font-weight:800;color:white;">${a.name} — ${a.product}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">${a.bank} · ${a.purpose||'—'} · ${a.phone}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:14px;font-weight:900;color:#f59e0b;">KES ${fmt(a.amount)}</div>
          <span class="bkp-status-badge pending">${a.status}</span>
        </div>
      </div>
    </div>`).join('')||`<div class="bkp-empty">No applications.</div>`}

    <div class="bkp-section-h" style="margin-top:24px;">🛒 BNPL Applications</div>
    ${allBnpl.slice(0,10).map(a=>`
    <div class="bkp-invoice-card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div><div style="font-size:13px;font-weight:800;color:white;">${a.name} — ${a.item}</div><div style="font-size:11px;color:rgba(255,255,255,0.4);">${a.planName} · ${a.seller}</div></div>
        <span class="bkp-status-badge pending">KES ${fmt(a.amount)}</span>
      </div>
    </div>`).join('')||`<div class="bkp-empty">No BNPL applications.</div>`}`;
  }

  /* ── FRAUD DETECTION ── */
  function checkFraudRisk(type, amount, uid){
    const key = `fraud_${type}_${uid}_${new Date().toDateString()}`;
    const daily = (lsGet(key)||0) + Number(amount);
    const limits = { deposit:100000, withdraw:50000, transfer:30000, bnpl:200000 };
    if(daily > (limits[type]||50000)){
      addNotification('security','⚠️ Unusual Activity Detected',`High ${type} volume detected on your account. If this wasn't you, contact support.`);
      return false;
    }
    lsSet(key, daily);
    return true;
  }

  /* ── SHARED MODAL ── */
  function openBkpModal(title, bodyHtml){
    let overlay=$('bkpProModal');
    if(!overlay){
      overlay=document.createElement('div');
      overlay.id='bkpProModal';
      overlay.className='bkp-pro-overlay';
      overlay.innerHTML=`<div class="bkp-pro-box">
        <button class="bkp-modal-close" onclick="BankingPro.closeBkpModal()">✕</button>
        <h3 class="bkp-modal-title" id="bkpProModalTitle"></h3>
        <div id="bkpProModalBody"></div>
      </div>`;
      document.body.appendChild(overlay);
    }
    $('bkpProModalTitle').textContent=title;
    $('bkpProModalBody').innerHTML=bodyHtml;
    overlay.classList.add('open');
  }
  function closeBkpModal(){
    const m=$('bkpProModal'); if(m) m.classList.remove('open');
  }

  /* ── INIT & TAB HOOK ── */
  const _rendered = {};
  function init(){
    /* Warm the claim cache so the Admin tab resolves instantly instead of
       showing "Checking access…" on first open. Auth may not have restored
       yet at init, so also refresh once it does. */
    _loadClaims(false).catch(() => {});
    try {
      const a = window.firebase?.auth?.() || window.firebaseAuth;
      if (a && typeof a.onAuthStateChanged === 'function') {
        a.onAuthStateChanged(() => {
          _claimsLoaded = false;
          _loadClaims(false).then(() => {
            /* If the admin pane already rendered a denial before the token
               resolved, re-render it now that the answer is authoritative. */
            if (_rendered && _rendered.admin && isAdmin()) renderAdminDashboard();
          }).catch(() => {});
        });
      }
    } catch (_) {}

    const origShow = window.showTab;
    window.showTab = function(name, btn, skip){
      origShow && origShow(name,btn,skip);
      if(_rendered[name]) return;
      _rendered[name]=true;
      if(name==='wallet')    renderWallet();
      if(name==='dashboard') renderFinancialDashboard();
      if(name==='bnpl')      renderBNPL();
      if(name==='merchant')  renderMerchantFinance();
      if(name==='invoices')  renderInvoices();
      if(name==='payments')  renderPaymentHistory();
      if(name==='admin')     renderAdminDashboard();
      if(name==='notifs')    renderNotifPanel();
    };
    updateNotifBadge();
    /* Trigger first tab if already active */
    const urlTab=new URLSearchParams(window.location.search).get('tab');
    if(['wallet','dashboard','bnpl','merchant','invoices','payments','admin','notifs'].includes(urlTab)){
      window.showTab(urlTab, document.getElementById('tab-'+urlTab));
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    renderWallet, renderWalletHistory, openWalletAction, closeWalletModal, submitWalletAction, quickDeposit,
    renderFinancialDashboard,
    calcBNPL, renderBNPL, openBNPLApplication, submitBNPLApplication, renderActiveBNPL,
    renderMerchantFinance, openMerchantRequest, submitMerchantRequest, renderMerchantApps,
    renderInvoices, filterInvoices, openCreateInvoice, submitInvoice, markInvoicePaid, sendInvoiceWA, deleteInvoice,
    renderPaymentHistory,
    addNotification, markNotifRead, markAllRead, renderNotifPanel, renderNotifications,
    renderAdminDashboard,
    checkFraudRisk,
    openBkpModal, closeBkpModal,
    walletTx, getWallet, isAdmin, ensureAdmin, init,
  };
})();


