/* ================================================================
   SOKONI UNIVERSAL AI SUBSCRIPTION OPERATING SYSTEM
   sasos-core.js — Universal Plan Registry + Subscription Lifecycle
   v1.0.0  |  2026-06-21

   Single source of truth for every Sokoni product subscription.
   Covers 13 product verticals with 46 plans.
   All state is server-authoritative. Client is never trusted.

   Exports:
     sasosSubscribe              — subscribe / upgrade a user to a plan
     sasosCancel                 — cancel (immediate or end-of-period)
     sasosGetSubscription        — get full universal subscription state
     sasosListPlans              — public: list plans for a product
     sasosCheckFeature           — zero-trust feature gate (server fresh read)
     sasosAdminListSubscriptions — admin: paginated subscription list
     sasosAdminUpdatePlanConfig  — superAdmin: update live plan config
     sasosExpireTrials           — scheduled daily: expire ended trials
     sasosProcessRenewals        — scheduled daily: flag due renewals
     sasosSyncLegacy             — admin: migrate old subscriptions to SASOS

   Firestore collections used:
     sasosSubscriptions/{uid}       — universal subscription document
     sasosPlans/{planId}            — live plan configuration (overridable)
     sasosPaymentRefs/{ref}         — idempotency keys
     sasosAuditLog/{entryId}        — immutable audit trail
     sasosBillingLedger/{txnId}     — immutable billing events (see sasos-billing.js)
     sasosUsage/{uid}_{product}_{period} — usage counters (see sasos-usage.js)

   Firebase Functions v2 calling convention throughout.
================================================================ */
'use strict';

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const { logger }              = require('firebase-functions');
const admin                   = require('firebase-admin');
const FieldValue              = admin.firestore.FieldValue;

const db = () => admin.firestore();

/* ── Auth guards ──────────────────────────────────────────── */
const assertAuth = req => {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return req.auth.uid;
};
const assertAdmin = req => {
  const uid = assertAuth(req);
  if (!req.auth.token?.admin && !req.auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required.');
  return uid;
};
const assertSuperAdmin = req => {
  const uid = assertAuth(req);
  if (!req.auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Super admin required.');
  return uid;
};

/* ── Input sanitiser ──────────────────────────────────────── */
const san = (s, n = 200) => typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim().slice(0, n) : '';

/* ── Period helper (YYYY-MM) ──────────────────────────────── */
const period = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };

/* ================================================================
   SASOS PLAN REGISTRY
   Single source of truth for ALL Sokoni product plans.
   Keys follow the pattern: {product}.{tier}
   -1 = unlimited  |  0 = not available  |  N = specific limit
================================================================ */
const SASOS_PLANS = {

  /* ── MARKETPLACE ───────────────────────────────────────── */
  'marketplace.free': {
    productId: 'marketplace', tier: 'free', name: 'Marketplace Free',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { listings: 3, products: 10, storage_gb: 0.5, api_calls_per_day: 100, seats: 1, ai_credits: 0, bandwidth_gb: 1 },
    features: { analytics: false, bulk_upload: false, api_access: false, featured_listing: false, whatsapp_orders: false, pos_integration: false, multi_branch: false, staff_accounts: false, export_data: false, custom_domain: false },
    commission: { rate_pct: 15, minimum_kes: 0 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'marketplace.starter': {
    productId: 'marketplace', tier: 'starter', name: 'Marketplace Starter',
    billing: { monthly: 499, annual: 4990, trialDays: 14, currency: 'KES' },
    limits: { listings: 20, products: 100, storage_gb: 5, api_calls_per_day: 500, seats: 2, ai_credits: 50, bandwidth_gb: 10 },
    features: { analytics: true, bulk_upload: false, api_access: false, featured_listing: true, whatsapp_orders: true, pos_integration: false, multi_branch: false, staff_accounts: false, export_data: false, custom_domain: false },
    commission: { rate_pct: 10, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'marketplace.pro': {
    productId: 'marketplace', tier: 'pro', name: 'Marketplace Pro',
    billing: { monthly: 1499, annual: 14990, trialDays: 14, currency: 'KES' },
    limits: { listings: 999, products: 5000, storage_gb: 50, api_calls_per_day: 5000, seats: 5, ai_credits: 200, bandwidth_gb: 100 },
    features: { analytics: true, bulk_upload: true, api_access: false, featured_listing: true, whatsapp_orders: true, pos_integration: true, multi_branch: false, staff_accounts: true, export_data: true, custom_domain: false },
    commission: { rate_pct: 7, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'marketplace.business': {
    productId: 'marketplace', tier: 'business', name: 'Marketplace Business',
    billing: { monthly: 4999, annual: 49990, trialDays: 7, currency: 'KES' },
    limits: { listings: -1, products: -1, storage_gb: 200, api_calls_per_day: 50000, seats: 20, ai_credits: 500, bandwidth_gb: 500 },
    features: { analytics: true, bulk_upload: true, api_access: true, featured_listing: true, whatsapp_orders: true, pos_integration: true, multi_branch: true, staff_accounts: true, export_data: true, custom_domain: true },
    commission: { rate_pct: 4, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'marketplace.enterprise': {
    productId: 'marketplace', tier: 'enterprise', name: 'Marketplace Enterprise',
    billing: { monthly: 14999, annual: 149990, trialDays: 7, currency: 'KES' },
    limits: { listings: -1, products: -1, storage_gb: 1000, api_calls_per_day: -1, seats: -1, ai_credits: 2000, bandwidth_gb: -1 },
    features: { analytics: true, bulk_upload: true, api_access: true, featured_listing: true, whatsapp_orders: true, pos_integration: true, multi_branch: true, staff_accounts: true, export_data: true, custom_domain: true, dedicated_support: true, sla_99_9: true },
    commission: { rate_pct: 2, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── SMARTPOS ──────────────────────────────────────────── */
  'smartpos.free': {
    productId: 'smartpos', tier: 'free', name: 'SmartPOS Free',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { terminals: 1, products: 50, transactions_per_day: 50, staff_accounts: 1, storage_gb: 0.5, ai_credits: 0, report_retention_days: 7 },
    features: { receipts: true, barcode: false, inventory: false, analytics: false, employee_mgmt: false, multi_branch: false, escrow: false, api_access: false, kitchen_display: false, loyalty: false },
    commission: { rate_pct: 1.5, minimum_kes: 5 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'smartpos.starter': {
    productId: 'smartpos', tier: 'starter', name: 'SmartPOS Starter',
    billing: { monthly: 799, annual: 7990, trialDays: 30, currency: 'KES' },
    limits: { terminals: 3, products: 500, transactions_per_day: 500, staff_accounts: 5, storage_gb: 5, ai_credits: 20, report_retention_days: 90 },
    features: { receipts: true, barcode: true, inventory: true, analytics: true, employee_mgmt: false, multi_branch: false, escrow: true, api_access: false, kitchen_display: false, loyalty: false },
    commission: { rate_pct: 1, minimum_kes: 5 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'smartpos.pro': {
    productId: 'smartpos', tier: 'pro', name: 'SmartPOS Pro',
    billing: { monthly: 2999, annual: 29990, trialDays: 14, currency: 'KES' },
    limits: { terminals: 10, products: 10000, transactions_per_day: -1, staff_accounts: 20, storage_gb: 50, ai_credits: 100, report_retention_days: 365 },
    features: { receipts: true, barcode: true, inventory: true, analytics: true, employee_mgmt: true, multi_branch: true, escrow: true, api_access: false, kitchen_display: true, loyalty: true },
    commission: { rate_pct: 0.75, minimum_kes: 5 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'smartpos.enterprise': {
    productId: 'smartpos', tier: 'enterprise', name: 'SmartPOS Enterprise',
    billing: { monthly: 9999, annual: 99990, trialDays: 7, currency: 'KES' },
    limits: { terminals: -1, products: -1, transactions_per_day: -1, staff_accounts: -1, storage_gb: 500, ai_credits: 500, report_retention_days: -1 },
    features: { receipts: true, barcode: true, inventory: true, analytics: true, employee_mgmt: true, multi_branch: true, escrow: true, api_access: true, kitchen_display: true, loyalty: true, white_label: true, dedicated_support: true },
    commission: { rate_pct: 0.5, minimum_kes: 5 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── AI STUDIO ─────────────────────────────────────────── */
  'ai.free': {
    productId: 'ai', tier: 'free', name: 'AI Studio Free',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { ai_credits: 0, storage_gb: 0.5, api_calls_per_day: 0 },
    quotas: { removeBackground: 10, enhanceProduct: 20, smartCrop: -1, generateBanner: 0, generatePoster: 0, createStory: 2, productTitles: 5, productDescriptions: 5, bulkUploadFiles: 5, seoOptimization: 0, marketingCopy: 0, apiCalls: 0 },
    features: { api_access: false, batch_processing: false, priority_queue: false, custom_models: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'ai.starter': {
    productId: 'ai', tier: 'starter', name: 'AI Studio Starter',
    billing: { monthly: 499, annual: 4990, trialDays: 14, currency: 'KES' },
    limits: { ai_credits: 50, storage_gb: 5, api_calls_per_day: 0 },
    quotas: { removeBackground: 100, enhanceProduct: 200, smartCrop: -1, generateBanner: 10, generatePoster: 10, createStory: 20, productTitles: -1, productDescriptions: 50, bulkUploadFiles: 50, seoOptimization: 30, marketingCopy: 0, apiCalls: 0 },
    features: { api_access: false, batch_processing: false, priority_queue: false, custom_models: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'ai.pro': {
    productId: 'ai', tier: 'pro', name: 'AI Studio Pro',
    billing: { monthly: 1499, annual: 14990, trialDays: 14, currency: 'KES' },
    limits: { ai_credits: 200, storage_gb: 50, api_calls_per_day: 0 },
    quotas: { removeBackground: -1, enhanceProduct: -1, smartCrop: -1, generateBanner: 50, generatePoster: 50, createStory: 100, productTitles: -1, productDescriptions: -1, bulkUploadFiles: 500, seoOptimization: -1, marketingCopy: 100, apiCalls: 0 },
    features: { api_access: false, batch_processing: true, priority_queue: false, custom_models: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'ai.enterprise': {
    productId: 'ai', tier: 'enterprise', name: 'AI Studio Enterprise',
    billing: { monthly: 9999, annual: 99990, trialDays: 7, currency: 'KES' },
    limits: { ai_credits: 1000, storage_gb: 500, api_calls_per_day: 50000 },
    quotas: { removeBackground: -1, enhanceProduct: -1, smartCrop: -1, generateBanner: -1, generatePoster: -1, createStory: -1, productTitles: -1, productDescriptions: -1, bulkUploadFiles: -1, seoOptimization: -1, marketingCopy: -1, apiCalls: 50000 },
    features: { api_access: true, batch_processing: true, priority_queue: true, custom_models: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── DELIVERY ──────────────────────────────────────────── */
  'delivery.free': {
    productId: 'delivery', tier: 'free', name: 'Delivery Basic',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { deliveries_per_month: 10, pickup_zones: 1, tracking_retention_days: 7, ai_credits: 0 },
    features: { real_time_tracking: true, sms_notifications: false, api_access: false, priority_dispatch: false, bulk_booking: false, analytics: false, dedicated_drivers: false },
    commission: { rate_pct: 12, minimum_kes: 50 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'delivery.starter': {
    productId: 'delivery', tier: 'starter', name: 'Delivery Starter',
    billing: { monthly: 299, annual: 2990, trialDays: 14, currency: 'KES' },
    limits: { deliveries_per_month: 100, pickup_zones: 5, tracking_retention_days: 30, ai_credits: 10 },
    features: { real_time_tracking: true, sms_notifications: true, api_access: false, priority_dispatch: false, bulk_booking: true, analytics: true, dedicated_drivers: false },
    commission: { rate_pct: 10, minimum_kes: 50 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'delivery.pro': {
    productId: 'delivery', tier: 'pro', name: 'Delivery Pro',
    billing: { monthly: 999, annual: 9990, trialDays: 14, currency: 'KES' },
    limits: { deliveries_per_month: 1000, pickup_zones: -1, tracking_retention_days: 90, ai_credits: 50 },
    features: { real_time_tracking: true, sms_notifications: true, api_access: false, priority_dispatch: true, bulk_booking: true, analytics: true, dedicated_drivers: true },
    commission: { rate_pct: 8, minimum_kes: 50 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'delivery.enterprise': {
    productId: 'delivery', tier: 'enterprise', name: 'Delivery Enterprise',
    billing: { monthly: 4999, annual: 49990, trialDays: 7, currency: 'KES' },
    limits: { deliveries_per_month: -1, pickup_zones: -1, tracking_retention_days: -1, ai_credits: 200 },
    features: { real_time_tracking: true, sms_notifications: true, api_access: true, priority_dispatch: true, bulk_booking: true, analytics: true, dedicated_drivers: true, sla_guarantee: true, custom_pricing: true },
    commission: { rate_pct: 5, minimum_kes: 50 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── LOGISTICS ─────────────────────────────────────────── */
  'logistics.starter': {
    productId: 'logistics', tier: 'starter', name: 'Logistics Starter',
    billing: { monthly: 999, annual: 9990, trialDays: 14, currency: 'KES' },
    limits: { warehouses: 1, sku_count: 500, shipments_per_month: 200, staff_accounts: 3, storage_gb: 5, ai_credits: 20 },
    features: { barcode_scanning: true, inventory_alerts: true, shipping_labels: true, analytics: false, api_access: false, multi_warehouse: false, 3pl_integration: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'logistics.pro': {
    productId: 'logistics', tier: 'pro', name: 'Logistics Pro',
    billing: { monthly: 2999, annual: 29990, trialDays: 14, currency: 'KES' },
    limits: { warehouses: 5, sku_count: 10000, shipments_per_month: 2000, staff_accounts: 15, storage_gb: 50, ai_credits: 100 },
    features: { barcode_scanning: true, inventory_alerts: true, shipping_labels: true, analytics: true, api_access: false, multi_warehouse: true, 3pl_integration: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'logistics.enterprise': {
    productId: 'logistics', tier: 'enterprise', name: 'Logistics Enterprise',
    billing: { monthly: 9999, annual: 99990, trialDays: 7, currency: 'KES' },
    limits: { warehouses: -1, sku_count: -1, shipments_per_month: -1, staff_accounts: -1, storage_gb: 500, ai_credits: 500 },
    features: { barcode_scanning: true, inventory_alerts: true, shipping_labels: true, analytics: true, api_access: true, multi_warehouse: true, 3pl_integration: true, dedicated_support: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── EVENTS ────────────────────────────────────────────── */
  'events.free': {
    productId: 'events', tier: 'free', name: 'Events Free',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { active_events: 1, tickets_per_event: 50, storage_gb: 0.5, ai_credits: 0 },
    features: { ticketing: true, qr_checkin: false, analytics: false, marketing_tools: false, api_access: false, recurring_events: false, seating_plans: false, refunds: false },
    commission: { rate_pct: 5, minimum_kes: 10 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'events.starter': {
    productId: 'events', tier: 'starter', name: 'Events Starter',
    billing: { monthly: 499, annual: 4990, trialDays: 14, currency: 'KES' },
    limits: { active_events: 5, tickets_per_event: 500, storage_gb: 2, ai_credits: 10 },
    features: { ticketing: true, qr_checkin: true, analytics: true, marketing_tools: false, api_access: false, recurring_events: false, seating_plans: false, refunds: true },
    commission: { rate_pct: 4, minimum_kes: 10 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'events.pro': {
    productId: 'events', tier: 'pro', name: 'Events Pro',
    billing: { monthly: 1499, annual: 14990, trialDays: 14, currency: 'KES' },
    limits: { active_events: 50, tickets_per_event: 10000, storage_gb: 20, ai_credits: 50 },
    features: { ticketing: true, qr_checkin: true, analytics: true, marketing_tools: true, api_access: false, recurring_events: true, seating_plans: true, refunds: true },
    commission: { rate_pct: 3, minimum_kes: 10 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'events.enterprise': {
    productId: 'events', tier: 'enterprise', name: 'Events Enterprise',
    billing: { monthly: 4999, annual: 49990, trialDays: 7, currency: 'KES' },
    limits: { active_events: -1, tickets_per_event: -1, storage_gb: 200, ai_credits: 200 },
    features: { ticketing: true, qr_checkin: true, analytics: true, marketing_tools: true, api_access: true, recurring_events: true, seating_plans: true, refunds: true, white_label: true, dedicated_support: true },
    commission: { rate_pct: 2, minimum_kes: 10 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── PROPERTY ──────────────────────────────────────────── */
  'property.free': {
    productId: 'property', tier: 'free', name: 'Property Free',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { listings: 3, storage_gb: 1, photos_per_listing: 5, ai_credits: 0 },
    features: { analytics: false, featured_listing: false, virtual_tour: false, landlord_tools: false, tenant_screening: false, rent_collection: false, maintenance_portal: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'property.starter': {
    productId: 'property', tier: 'starter', name: 'Property Starter',
    billing: { monthly: 999, annual: 9990, trialDays: 14, currency: 'KES' },
    limits: { listings: 20, storage_gb: 10, photos_per_listing: 20, ai_credits: 20 },
    features: { analytics: true, featured_listing: true, virtual_tour: false, landlord_tools: true, tenant_screening: false, rent_collection: true, maintenance_portal: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'property.pro': {
    productId: 'property', tier: 'pro', name: 'Property Pro',
    billing: { monthly: 2999, annual: 29990, trialDays: 14, currency: 'KES' },
    limits: { listings: 999, storage_gb: 100, photos_per_listing: 50, ai_credits: 100 },
    features: { analytics: true, featured_listing: true, virtual_tour: true, landlord_tools: true, tenant_screening: true, rent_collection: true, maintenance_portal: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'property.enterprise': {
    productId: 'property', tier: 'enterprise', name: 'Property Enterprise',
    billing: { monthly: 7999, annual: 79990, trialDays: 7, currency: 'KES' },
    limits: { listings: -1, storage_gb: 1000, photos_per_listing: -1, ai_credits: 500 },
    features: { analytics: true, featured_listing: true, virtual_tour: true, landlord_tools: true, tenant_screening: true, rent_collection: true, maintenance_portal: true, api_access: true, dedicated_support: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── VEHICLES ──────────────────────────────────────────── */
  'vehicles.free': {
    productId: 'vehicles', tier: 'free', name: 'Vehicles Free',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { listings: 3, storage_gb: 1, photos_per_listing: 5, ai_credits: 0 },
    features: { rental_calendar: false, insurance_tracking: false, fleet_management: false, analytics: false, gps_tracking: false, maintenance_log: false },
    commission: { rate_pct: 5, minimum_kes: 100 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'vehicles.starter': {
    productId: 'vehicles', tier: 'starter', name: 'Vehicles Starter',
    billing: { monthly: 799, annual: 7990, trialDays: 14, currency: 'KES' },
    limits: { listings: 20, storage_gb: 10, photos_per_listing: 20, ai_credits: 20 },
    features: { rental_calendar: true, insurance_tracking: true, fleet_management: false, analytics: true, gps_tracking: false, maintenance_log: true },
    commission: { rate_pct: 4, minimum_kes: 100 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'vehicles.pro': {
    productId: 'vehicles', tier: 'pro', name: 'Vehicles Pro',
    billing: { monthly: 2499, annual: 24990, trialDays: 14, currency: 'KES' },
    limits: { listings: 999, storage_gb: 100, photos_per_listing: 50, ai_credits: 100 },
    features: { rental_calendar: true, insurance_tracking: true, fleet_management: true, analytics: true, gps_tracking: true, maintenance_log: true },
    commission: { rate_pct: 3, minimum_kes: 100 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'vehicles.enterprise': {
    productId: 'vehicles', tier: 'enterprise', name: 'Vehicles Enterprise',
    billing: { monthly: 6999, annual: 69990, trialDays: 7, currency: 'KES' },
    limits: { listings: -1, storage_gb: 500, photos_per_listing: -1, ai_credits: 500 },
    features: { rental_calendar: true, insurance_tracking: true, fleet_management: true, analytics: true, gps_tracking: true, maintenance_log: true, api_access: true, dedicated_support: true },
    commission: { rate_pct: 2, minimum_kes: 100 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── ADVERTISING ───────────────────────────────────────── */
  'advertising.starter': {
    productId: 'advertising', tier: 'starter', name: 'Advertising Starter',
    billing: { monthly: 299, annual: 2990, trialDays: 7, currency: 'KES' },
    limits: { impressions_per_month: 5000, active_campaigns: 3, storage_gb: 1, ai_credits: 10 },
    features: { ab_testing: false, retargeting: false, analytics: true, video_ads: false, audience_targeting: false, api_access: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'advertising.pro': {
    productId: 'advertising', tier: 'pro', name: 'Advertising Pro',
    billing: { monthly: 999, annual: 9990, trialDays: 7, currency: 'KES' },
    limits: { impressions_per_month: 100000, active_campaigns: 20, storage_gb: 10, ai_credits: 50 },
    features: { ab_testing: true, retargeting: true, analytics: true, video_ads: true, audience_targeting: true, api_access: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'advertising.business': {
    productId: 'advertising', tier: 'business', name: 'Advertising Business',
    billing: { monthly: 3999, annual: 39990, trialDays: 7, currency: 'KES' },
    limits: { impressions_per_month: 1000000, active_campaigns: -1, storage_gb: 50, ai_credits: 200 },
    features: { ab_testing: true, retargeting: true, analytics: true, video_ads: true, audience_targeting: true, api_access: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'advertising.enterprise': {
    productId: 'advertising', tier: 'enterprise', name: 'Advertising Enterprise',
    billing: { monthly: 9999, annual: 99990, trialDays: 7, currency: 'KES' },
    limits: { impressions_per_month: -1, active_campaigns: -1, storage_gb: 500, ai_credits: 1000 },
    features: { ab_testing: true, retargeting: true, analytics: true, video_ads: true, audience_targeting: true, api_access: true, dedicated_support: true, custom_placements: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── BUSINESS PAGES ────────────────────────────────────── */
  'business.free': {
    productId: 'business', tier: 'free', name: 'Business Pages Free',
    billing: { monthly: 0, annual: 0, trialDays: 0, currency: 'KES' },
    limits: { pages: 1, storage_gb: 0.5, team_members: 1, ai_credits: 0 },
    features: { analytics: false, booking_widget: false, verified_badge: false, custom_url: false, api_access: false, priority_search: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: false, vat_rate: 0 },
  },
  'business.starter': {
    productId: 'business', tier: 'starter', name: 'Business Pages Starter',
    billing: { monthly: 299, annual: 2990, trialDays: 14, currency: 'KES' },
    limits: { pages: 3, storage_gb: 2, team_members: 3, ai_credits: 10 },
    features: { analytics: true, booking_widget: true, verified_badge: false, custom_url: true, api_access: false, priority_search: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'business.pro': {
    productId: 'business', tier: 'pro', name: 'Business Pages Pro',
    billing: { monthly: 999, annual: 9990, trialDays: 14, currency: 'KES' },
    limits: { pages: -1, storage_gb: 20, team_members: 10, ai_credits: 50 },
    features: { analytics: true, booking_widget: true, verified_badge: true, custom_url: true, api_access: true, priority_search: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'business.enterprise': {
    productId: 'business', tier: 'enterprise', name: 'Business Pages Enterprise',
    billing: { monthly: 2999, annual: 29990, trialDays: 7, currency: 'KES' },
    limits: { pages: -1, storage_gb: 200, team_members: -1, ai_credits: 200 },
    features: { analytics: true, booking_widget: true, verified_badge: true, custom_url: true, api_access: true, priority_search: true, dedicated_support: true, white_label: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── WAREHOUSING ───────────────────────────────────────── */
  'warehousing.starter': {
    productId: 'warehousing', tier: 'starter', name: 'Warehousing Starter',
    billing: { monthly: 999, annual: 9990, trialDays: 14, currency: 'KES' },
    limits: { pallet_capacity: 100, sku_count: 500, staff_accounts: 3, storage_gb: 5, ai_credits: 20 },
    features: { barcode_scanning: true, receiving: true, dispatch: true, analytics: false, api_access: false, multi_location: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'warehousing.pro': {
    productId: 'warehousing', tier: 'pro', name: 'Warehousing Pro',
    billing: { monthly: 3999, annual: 39990, trialDays: 14, currency: 'KES' },
    limits: { pallet_capacity: 1000, sku_count: 10000, staff_accounts: 15, storage_gb: 50, ai_credits: 100 },
    features: { barcode_scanning: true, receiving: true, dispatch: true, analytics: true, api_access: false, multi_location: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'warehousing.enterprise': {
    productId: 'warehousing', tier: 'enterprise', name: 'Warehousing Enterprise',
    billing: { monthly: 9999, annual: 99990, trialDays: 7, currency: 'KES' },
    limits: { pallet_capacity: -1, sku_count: -1, staff_accounts: -1, storage_gb: 500, ai_credits: 500 },
    features: { barcode_scanning: true, receiving: true, dispatch: true, analytics: true, api_access: true, multi_location: true, dedicated_support: true, custom_integration: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── FINANCE ───────────────────────────────────────────── */
  'finance.starter': {
    productId: 'finance', tier: 'starter', name: 'Finance Starter',
    billing: { monthly: 299, annual: 2990, trialDays: 14, currency: 'KES' },
    limits: { invoices_per_month: 50, clients: 50, staff_accounts: 2, storage_gb: 2, ai_credits: 10 },
    features: { invoicing: true, expense_tracking: true, payroll: false, multi_currency: false, vat_returns: false, api_access: false, bank_reconciliation: false, etims: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'finance.pro': {
    productId: 'finance', tier: 'pro', name: 'Finance Pro',
    billing: { monthly: 999, annual: 9990, trialDays: 14, currency: 'KES' },
    limits: { invoices_per_month: -1, clients: -1, staff_accounts: 10, storage_gb: 20, ai_credits: 50 },
    features: { invoicing: true, expense_tracking: true, payroll: true, multi_currency: true, vat_returns: true, api_access: false, bank_reconciliation: true, etims: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'finance.enterprise': {
    productId: 'finance', tier: 'enterprise', name: 'Finance Enterprise',
    billing: { monthly: 3999, annual: 39990, trialDays: 7, currency: 'KES' },
    limits: { invoices_per_month: -1, clients: -1, staff_accounts: -1, storage_gb: 200, ai_credits: 200 },
    features: { invoicing: true, expense_tracking: true, payroll: true, multi_currency: true, vat_returns: true, api_access: true, bank_reconciliation: true, etims: true, dedicated_support: true, custom_workflows: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },

  /* ── ANALYTICS ─────────────────────────────────────────── */
  'analytics.starter': {
    productId: 'analytics', tier: 'starter', name: 'Analytics Starter',
    billing: { monthly: 499, annual: 4990, trialDays: 14, currency: 'KES' },
    limits: { data_retention_days: 30, dashboards: 5, reports_per_month: 20, storage_gb: 2, ai_credits: 10, data_exports: 5 },
    features: { real_time: false, custom_reports: false, api_access: false, white_label: false, alerts: true, benchmarking: false },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'analytics.pro': {
    productId: 'analytics', tier: 'pro', name: 'Analytics Pro',
    billing: { monthly: 1999, annual: 19990, trialDays: 14, currency: 'KES' },
    limits: { data_retention_days: 365, dashboards: -1, reports_per_month: -1, storage_gb: 50, ai_credits: 100, data_exports: -1 },
    features: { real_time: true, custom_reports: true, api_access: false, white_label: false, alerts: true, benchmarking: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
  'analytics.enterprise': {
    productId: 'analytics', tier: 'enterprise', name: 'Analytics Enterprise',
    billing: { monthly: 4999, annual: 49990, trialDays: 7, currency: 'KES' },
    limits: { data_retention_days: -1, dashboards: -1, reports_per_month: -1, storage_gb: 500, ai_credits: 500, data_exports: -1 },
    features: { real_time: true, custom_reports: true, api_access: true, white_label: true, alerts: true, benchmarking: true, dedicated_support: true },
    commission: { rate_pct: 0, minimum_kes: 0 },
    tax: { vat_applicable: true, vat_rate: 0.16 },
  },
};

/* ── Products list ────────────────────────────────────────── */
const SASOS_PRODUCTS = ['marketplace','smartpos','ai','delivery','logistics','events','property','vehicles','advertising','business','warehousing','finance','analytics'];

/* ── Tier ordering for upgrade/downgrade validation ──────── */
const TIER_ORDER = { free: 0, starter: 1, pro: 2, business: 3, enterprise: 4 };

/* ── Plan resolution (Firestore overrides code defaults) ─── */
async function _resolvePlan(planId) {
  /* Try live Firestore config first (allows pricing updates without deployment) */
  const snap = await db().collection('sasosPlans').doc(planId).get();
  if (snap.exists) {
    const data = snap.data();
    /* Merge code defaults with Firestore overrides — Firestore wins on conflicts */
    return { ...(SASOS_PLANS[planId] || {}), ...data, planId };
  }
  const codeDefault = SASOS_PLANS[planId];
  if (!codeDefault) return null;
  return { ...codeDefault, planId };
}

/* ── Resolve user's active planId for a product ──────────── */
async function _getActivePlanId(uid, product) {
  const snap = await db().collection('sasosSubscriptions').doc(uid).get();
  if (!snap.exists) return `${product}.free`;
  const prodState = snap.data().products?.[product];
  if (!prodState) return `${product}.free`;
  if (prodState.status === 'cancelled') return `${product}.free`;
  return prodState.planId || `${product}.free`;
}

/* ── Write immutable audit entry ─────────────────────────── */
async function _audit(type, uid, data = {}) {
  return db().collection('sasosAuditLog').add({
    type, uid, ...data,
    ts: admin.firestore.FieldValue.serverTimestamp(),
    server: true,
  });
}

/* ── Write immutable billing ledger entry ────────────────── */
async function _ledger(type, uid, amount, currency, data = {}) {
  return db().collection('sasosBillingLedger').add({
    type, uid, amount, currency, ...data,
    ts: admin.firestore.FieldValue.serverTimestamp(),
    immutable: true,
  });
}

/* ── Calculate period end from now ──────────────────────── */
function _periodEnd(billing) {
  const ms = billing === 'annual' ? 365 * 86400000 : 30 * 86400000;
  return Date.now() + ms;
}

/* ── Calculate proration credit ─────────────────────────── */
function _prorationCredit(currentPlanPrice, periodStart, periodEnd, billing) {
  if (currentPlanPrice <= 0) return 0;
  const total = billing === 'annual' ? 365 * 86400000 : 30 * 86400000;
  const remaining = Math.max(0, periodEnd - Date.now());
  const fraction = remaining / total;
  return Math.round(currentPlanPrice * fraction);
}

/* ================================================================
   sasosSubscribe
   Subscribes a user to a plan or upgrades an existing subscription.
   Handles: new subscriptions, upgrades, billing-cycle changes.
   Downgrades are handled separately (scheduled at period end).
   Requires payment reference for paid plans.
================================================================ */
const sasosSubscribe = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const planId   = san(req.data.planId, 60);
    const billing  = req.data.billing === 'annual' ? 'annual' : 'monthly';
    const payRef   = san(req.data.paymentRef || '', 120);
    const trialKey = san(req.data.trialCode  || '', 60);

    /* Validate plan exists */
    const plan = await _resolvePlan(planId);
    if (!plan) throw new HttpsError('not-found', `Unknown plan: ${planId}`);

    const { productId, tier, billing: planBilling, limits, commission } = plan;
    const price = billing === 'annual' ? planBilling.annual : planBilling.monthly;

    /* Free plan — no payment required */
    if (price > 0 && !payRef && !trialKey)
      throw new HttpsError('invalid-argument', 'paymentRef required for paid plans.');

    /* Payment idempotency */
    if (payRef) {
      const idemRef = db().collection('sasosPaymentRefs').doc(payRef);
      const idem    = await idemRef.get();
      if (idem.exists) return { success: true, idempotent: true, subscription: idem.data().subscription };
    }

    const now       = Date.now();
    const batch     = db().batch();
    const subRef    = db().collection('sasosSubscriptions').doc(uid);
    const subSnap   = await subRef.get();
    const current   = subSnap.exists ? (subSnap.data().products?.[productId] || {}) : {};

    /* Trial logic */
    const isTrial = trialKey !== '' && tier !== 'free';
    const trialDays = isTrial ? (planBilling.trialDays || 0) : 0;

    const newState = {
      planId,
      productId,
      tier,
      status:      isTrial ? 'trial' : 'active',
      billing,
      periodStart: now,
      periodEnd:   isTrial
        ? now + trialDays * 86400000
        : _periodEnd(billing),
      trialEnd:    isTrial ? now + trialDays * 86400000 : null,
      activatedAt: current.activatedAt || now,
      paymentRef:  payRef || null,
      pendingPlanId: null,
      pendingBilling: null,
      cancelAt:    null,
      updatedAt:   now,
    };

    batch.set(subRef, {
      uid,
      products: { [productId]: newState },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    /* Idempotency key */
    if (payRef) {
      batch.set(db().collection('sasosPaymentRefs').doc(payRef), {
        uid, planId, billing, processedAt: now,
        subscription: { planId, productId, tier, status: newState.status },
      });
    }

    /* Allocate AI credits for plans that include them */
    if (limits.ai_credits > 0) {
      batch.set(db().collection('aiCredits').doc(uid), {
        uid,
        balance:        FieldValue.increment(limits.ai_credits),
        totalPurchased: FieldValue.increment(limits.ai_credits),
        lastCredited:   now,
      }, { merge: true });
    }

    /* Billing ledger entry (only for paid, non-trial subscriptions) */
    if (price > 0 && !isTrial) {
      const taxAmount = plan.tax?.vat_applicable ? Math.round(price * (plan.tax.vat_rate || 0.16)) : 0;
      const ledgerId  = db().collection('sasosBillingLedger').doc();
      batch.set(ledgerId, {
        type: 'subscription_payment', uid, planId, productId, tier, billing,
        amount: price, tax: taxAmount, total: price + taxAmount,
        currency: planBilling.currency || 'KES', paymentRef: payRef,
        periodStart: now, periodEnd: newState.periodEnd,
        ts: FieldValue.serverTimestamp(), immutable: true,
      });
    }

    /* Audit log */
    const auditRef = db().collection('sasosAuditLog').doc();
    batch.set(auditRef, {
      type: 'sasos_subscribe', uid, planId, productId, tier, billing,
      price, payRef: payRef || null, isTrial,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    /* Invalidate entitlement cache */
    batch.set(db().collection('entitlements').doc(uid), { updatedAt: now, needsRefresh: true }, { merge: true });

    await batch.commit();
    logger.info(`[SASOS] subscribe: uid=${uid} plan=${planId} billing=${billing} trial=${isTrial}`);

    return { success: true, subscription: newState };
  }
);

/* ================================================================
   sasosCancel
   Cancels a subscription. Two modes:
   - immediate: cancels now, marks status = 'cancelled'
   - end_of_period (default): sets cancelAt = periodEnd, status stays active
================================================================ */
const sasosCancel = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const uid       = assertAuth(req);
    const product   = san(req.data.product, 30);
    const immediate = req.data.immediate === true;
    const reason    = san(req.data.reason || '', 200);

    if (!SASOS_PRODUCTS.includes(product))
      throw new HttpsError('invalid-argument', `Unknown product: ${product}`);

    const subRef  = db().collection('sasosSubscriptions').doc(uid);
    const subSnap = await subRef.get();

    if (!subSnap.exists) throw new HttpsError('not-found', 'No subscription found.');

    const prodState = subSnap.data().products?.[product];
    if (!prodState) throw new HttpsError('not-found', `No ${product} subscription.`);
    if (prodState.status === 'cancelled') return { success: true, alreadyCancelled: true };

    const now   = Date.now();
    const batch = db().batch();

    if (immediate) {
      batch.update(subRef, {
        [`products.${product}.status`]:      'cancelled',
        [`products.${product}.cancelledAt`]: now,
        [`products.${product}.updatedAt`]:   now,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      batch.update(subRef, {
        [`products.${product}.cancelAt`]:  prodState.periodEnd || now,
        [`products.${product}.updatedAt`]: now,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const auditRef = db().collection('sasosAuditLog').doc();
    batch.set(auditRef, {
      type: immediate ? 'sasos_cancel_immediate' : 'sasos_cancel_scheduled',
      uid, product, reason, ts: FieldValue.serverTimestamp(), server: true,
    });

    batch.set(db().collection('entitlements').doc(uid), { updatedAt: now, needsRefresh: true }, { merge: true });

    await batch.commit();
    logger.info(`[SASOS] cancel: uid=${uid} product=${product} immediate=${immediate}`);

    return { success: true, immediate, cancelAt: immediate ? now : (prodState.periodEnd || now) };
  }
);

/* ================================================================
   sasosGetSubscription
   Returns the user's complete universal subscription state.
   Includes active plan details and current usage snapshot.
   Always reads fresh from Firestore — never cached.
================================================================ */
const sasosGetSubscription = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const uid = assertAuth(req);

    const [subSnap, credSnap] = await Promise.all([
      db().collection('sasosSubscriptions').doc(uid).get(),
      db().collection('aiCredits').doc(uid).get(),
    ]);

    const now = Date.now();
    const products = {};

    /* Build per-product state with plan details merged in */
    for (const product of SASOS_PRODUCTS) {
      const prodState = subSnap.exists ? (subSnap.data().products?.[product] || null) : null;

      /* Auto-compute status: if past cancelAt or periodEnd → reflect that */
      let planId = prodState?.planId || `${product}.free`;
      let status = prodState?.status || 'active';

      if (status === 'active' || status === 'trial') {
        if (prodState?.cancelAt && prodState.cancelAt <= now) status = 'cancelled';
        else if (prodState?.trialEnd && prodState.trialEnd <= now && status === 'trial') status = 'trial_expired';
        else if (prodState?.periodEnd && prodState.periodEnd <= now && status === 'active') status = 'renewal_due';
      }

      const plan = await _resolvePlan(planId);
      products[product] = {
        planId,
        tier: plan?.tier || 'free',
        status,
        billing: prodState?.billing || 'monthly',
        periodEnd: prodState?.periodEnd || null,
        cancelAt:  prodState?.cancelAt  || null,
        pendingPlanId: prodState?.pendingPlanId || null,
        limits:   plan?.limits   || {},
        features: plan?.features  || {},
        commission: plan?.commission || { rate_pct: 0 },
      };
    }

    const aiCredits = credSnap.exists ? (credSnap.data().balance || 0) : 0;

    return { uid, products, aiCredits, fetchedAt: now };
  }
);

/* ================================================================
   sasosListPlans
   Public endpoint — returns all available plans for a product.
   No authentication required.
================================================================ */
const sasosListPlans = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    const product = san(req.data.product || '', 30);

    const filtered = Object.entries(SASOS_PLANS)
      .filter(([id]) => !product || id.startsWith(`${product}.`))
      .map(([planId, def]) => ({
        planId,
        ...def,
        /* Strip internal-only fields */
        _private: undefined,
      }));

    /* Check Firestore for any admin-overridden prices */
    const overrides = await db().collection('sasosPlans')
      .where('productId', '==', product || '__all__')
      .get().catch(() => ({ docs: [] }));

    const overrideMap = {};
    overrides.docs.forEach(d => { overrideMap[d.id] = d.data(); });

    return filtered.map(p => overrideMap[p.planId] ? { ...p, ...overrideMap[p.planId] } : p);
  }
);

/* ================================================================
   sasosCheckFeature
   Zero-trust feature gate. Always reads FRESH subscription state.
   Used by all Sokoni services to gate access to product features.
================================================================ */
const sasosCheckFeature = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const product = san(req.data.product, 30);
    const feature = san(req.data.feature, 60);

    if (!SASOS_PRODUCTS.includes(product))
      return { allowed: false, reason: `Unknown product: ${product}` };

    const planId = await _getActivePlanId(uid, product);
    const plan   = await _resolvePlan(planId);
    if (!plan) return { allowed: false, reason: 'Plan not found.' };

    const subSnap   = await db().collection('sasosSubscriptions').doc(uid).get();
    const prodState = subSnap.exists ? subSnap.data().products?.[product] : null;
    const status    = prodState?.status || 'active';

    if (status === 'cancelled')     return { allowed: false, reason: 'Subscription cancelled.', planId, product };
    if (status === 'suspended')     return { allowed: false, reason: 'Account suspended.', planId, product, suspended: true };
    if (status === 'trial_expired') return { allowed: false, reason: 'Trial expired.', planId, product, upgradeRequired: true };

    /* Feature flag check */
    const hasFeature = plan.features?.[feature];
    if (hasFeature === false)
      return { allowed: false, reason: `${feature} not available on ${plan.name}.`, planId, product, feature, upgradeRequired: true };

    /* Usage quota check (for AI product) */
    if (product === 'ai' && plan.quotas) {
      const quota = plan.quotas[feature];
      if (quota === 0) return { allowed: false, remaining: 0, reason: `${feature} not available on ${plan.name}.`, planId, product, feature, upgradeRequired: true };
      if (quota === -1) return { allowed: true, remaining: -1, source: 'unlimited', planId, product, feature };

      if (quota !== undefined) {
        const p = period();
        const usageSnap = await db().collection('sasosUsage').doc(`${uid}_ai_${p}`).get();
        const used = usageSnap.exists ? (usageSnap.data().counters?.[feature] || 0) : 0;
        const remaining = Math.max(0, quota - used);
        if (remaining <= 0) return { allowed: false, remaining: 0, used, limit: quota, reason: `Monthly ${feature} limit reached.`, planId, product, feature, upgradeRequired: true };
        return { allowed: true, remaining, used, limit: quota, warn: remaining <= Math.ceil(quota * 0.2), planId, product, feature };
      }
    }

    /* Numeric limits check */
    const limit = plan.limits?.[feature];
    if (limit === 0) return { allowed: false, reason: `${feature} limit is 0 on ${plan.name}.`, planId, product, feature, upgradeRequired: true };
    if (limit === -1) return { allowed: true, remaining: -1, source: 'unlimited', planId, product, feature };

    return { allowed: true, planId, product, feature, tier: plan.tier };
  }
);

/* ================================================================
   sasosAdminListSubscriptions
   Admin-only. Paginated list of all subscriptions with filters.
================================================================ */
const sasosAdminListSubscriptions = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const pageSize = Math.min(req.data.pageSize || 25, 100);
    const after    = req.data.after || null;
    const product  = san(req.data.product || '', 30);
    const tier     = san(req.data.tier    || '', 20);
    const status   = san(req.data.status  || '', 20);

    let q = db().collection('sasosSubscriptions').orderBy('updatedAt', 'desc').limit(pageSize);
    if (after) q = q.startAfter(await db().collection('sasosSubscriptions').doc(after).get());

    const snap  = await q.get();
    const items = snap.docs.map(d => {
      const data    = d.data();
      const prods   = data.products || {};
      /* Filter by product/tier/status if specified */
      if (product && !prods[product]) return null;
      if (product && status && prods[product]?.status !== status) return null;
      if (product && tier && prods[product]?.tier !== tier) return null;
      return { uid: d.id, ...data };
    }).filter(Boolean);

    return { items, total: items.length, hasMore: snap.docs.length === pageSize };
  }
);

/* ================================================================
   sasosAdminUpdatePlanConfig
   SuperAdmin only. Updates live plan configuration in Firestore.
   Changes take effect immediately on next sasosCheckFeature call.
   Requires dual-field signature (proposedBy + approvedBy must differ).
================================================================ */
const sasosAdminUpdatePlanConfig = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const uid = assertSuperAdmin(req);
    const planId = san(req.data.planId, 60);
    const changes = req.data.changes;
    const approvedBy = san(req.data.approvedBy || '', 128);

    if (!planId || !changes || typeof changes !== 'object')
      throw new HttpsError('invalid-argument', 'planId and changes required.');

    /* Prevent single-admin self-approval for financial fields */
    const financialFields = ['billing', 'commission', 'tax'];
    const touchesFinancial = financialFields.some(f => f in changes);
    if (touchesFinancial && (!approvedBy || approvedBy === uid))
      throw new HttpsError('failed-precondition', 'Financial changes require a second approving admin UID (approvedBy != your UID).');

    const baseCode = SASOS_PLANS[planId];
    if (!baseCode) throw new HttpsError('not-found', `Plan ${planId} not in code registry.`);

    const batch   = db().batch();
    const planRef = db().collection('sasosPlans').doc(planId);
    batch.set(planRef, {
      ...changes,
      planId,
      updatedAt:  FieldValue.serverTimestamp(),
      updatedBy:  uid,
      approvedBy: approvedBy || null,
    }, { merge: true });

    const auditRef = db().collection('sasosAuditLog').doc();
    batch.set(auditRef, {
      type: 'sasos_plan_config_update', uid, planId, changes,
      approvedBy: approvedBy || null, touchesFinancial,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[SASOS] plan_config_update: uid=${uid} planId=${planId} financial=${touchesFinancial}`);
    return { success: true, planId };
  }
);

/* ================================================================
   sasosExpireTrials  [Scheduled — daily 08:00 EAT]
   Finds all trial subscriptions whose trialEnd has passed.
   Converts them to free tier or suspends (if auto-upgrade not set).
================================================================ */
const sasosExpireTrials = onSchedule(
  { schedule: '0 5 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1', memory: '256MiB', timeoutSeconds: 300 },
  async () => {
    const now   = Date.now();
    const batch = db().batch();
    let   count = 0;

    for (const product of SASOS_PRODUCTS) {
      const snap = await db().collection('sasosSubscriptions')
        .where(`products.${product}.status`,   '==', 'trial')
        .where(`products.${product}.trialEnd`, '<=', now)
        .limit(200).get();

      for (const doc of snap.docs) {
        const uid = doc.id;
        /* Downgrade to free */
        batch.update(doc.ref, {
          [`products.${product}.status`]:    'active',
          [`products.${product}.planId`]:    `${product}.free`,
          [`products.${product}.tier`]:      'free',
          [`products.${product}.updatedAt`]: now,
          updatedAt: FieldValue.serverTimestamp(),
        });
        const auditRef = db().collection('sasosAuditLog').doc();
        batch.set(auditRef, {
          type: 'sasos_trial_expired', uid, product,
          ts: FieldValue.serverTimestamp(), server: true,
        });
        count++;
      }
    }

    if (count > 0) await batch.commit();
    logger.info(`[SASOS] sasosExpireTrials: expired ${count} trials`);
  }
);

/* ================================================================
   sasosProcessRenewals  [Scheduled — daily 07:00 EAT]
   Marks subscriptions whose periodEnd is within 48 hours as
   'renewal_due'. The billing engine (sasos-billing.js) processes
   the actual charge. Failed charges trigger the dunning sequence.
================================================================ */
const sasosProcessRenewals = onSchedule(
  { schedule: '0 4 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1', memory: '256MiB', timeoutSeconds: 300 },
  async () => {
    const now      = Date.now();
    const horizon  = now + 48 * 3600 * 1000;   /* 48-hour look-ahead */
    const batch    = db().batch();
    let   flagged  = 0;

    for (const product of SASOS_PRODUCTS) {
      const snap = await db().collection('sasosSubscriptions')
        .where(`products.${product}.status`,    '==', 'active')
        .where(`products.${product}.periodEnd`, '<=', horizon)
        .limit(200).get();

      for (const doc of snap.docs) {
        const uid       = doc.id;
        const prodState = doc.data().products?.[product];
        if (!prodState || prodState.tier === 'free') continue;

        batch.update(doc.ref, {
          [`products.${product}.renewalDue`]: true,
          [`products.${product}.updatedAt`]:  now,
          updatedAt: FieldValue.serverTimestamp(),
        });

        /* Create a renewal task document for the billing engine */
        const renewalRef = db().collection('sasosRenewalQueue').doc(`${uid}_${product}`);
        batch.set(renewalRef, {
          uid, product, planId: prodState.planId, billing: prodState.billing,
          periodEnd: prodState.periodEnd, flaggedAt: now, status: 'pending',
        }, { merge: true });

        flagged++;
      }
    }

    if (flagged > 0) await batch.commit();
    logger.info(`[SASOS] sasosProcessRenewals: flagged ${flagged} renewals`);
  }
);

/* ================================================================
   sasosSyncLegacy  [Admin trigger]
   One-time migration: reads old aiSubscriptions + subscriptions
   collections and writes them into the unified sasosSubscriptions
   format. Safe to re-run — idempotent.
================================================================ */
const sasosSyncLegacy = onCall(
  { region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async (req) => {
    assertAdmin(req);
    const targetUid = san(req.data.uid || '', 128);

    /* Sync a single user or all (up to 500 in a batch) */
    let aiSnaps, mktSnaps;
    if (targetUid) {
      const [aiS, mktS] = await Promise.all([
        db().collection('aiSubscriptions').doc(targetUid).get(),
        db().collection('subscriptions').doc(targetUid).get(),
      ]);
      aiSnaps  = aiS.exists  ? [aiS]  : [];
      mktSnaps = mktS.exists ? [mktS] : [];
    } else {
      [aiSnaps, mktSnaps] = await Promise.all([
        db().collection('aiSubscriptions').limit(500).get().then(s => s.docs),
        db().collection('subscriptions').limit(500).get().then(s => s.docs),
      ]);
    }

    const uidSet = new Set([...aiSnaps.map(d => d.id), ...mktSnaps.map(d => d.id)]);
    const batch  = db().batch();
    let   synced = 0;

    for (const uid of uidSet) {
      const aiDoc  = aiSnaps.find(d => d.id === uid);
      const mktDoc = mktSnaps.find(d => d.id === uid);
      const now    = Date.now();
      const upd    = {};

      if (aiDoc?.exists) {
        const d = aiDoc.data();
        const legacyPlanId = d.plan ? `ai.${d.plan.replace('ai_','').replace('_','.')}` : 'ai.free';
        const normId = SASOS_PLANS[legacyPlanId] ? legacyPlanId : `ai.${d.plan || 'free'}`;
        upd['products.ai'] = {
          planId: normId, productId: 'ai', tier: normId.split('.')[1] || 'free',
          status: d.status || 'active', billing: d.billing || 'monthly',
          periodStart: d.currentPeriodStart || now,
          periodEnd:   d.currentPeriodEnd   || now + 30 * 86400000,
          activatedAt: d.activatedAt || now, updatedAt: now,
          pendingPlanId: null, cancelAt: null, legacySynced: true,
        };
      }

      if (mktDoc?.exists) {
        const d = mktDoc.data();
        const normId = `marketplace.${d.plan || 'free'}`;
        upd['products.marketplace'] = {
          planId: normId, productId: 'marketplace', tier: d.plan || 'free',
          status: d.status || 'active', billing: d.billing || 'monthly',
          periodStart: d.currentPeriodStart || now,
          periodEnd:   d.currentPeriodEnd   || now + 30 * 86400000,
          activatedAt: d.activatedAt || now, updatedAt: now,
          pendingPlanId: null, cancelAt: null, legacySynced: true,
        };
      }

      if (Object.keys(upd).length) {
        batch.set(db().collection('sasosSubscriptions').doc(uid), {
          uid, ...upd, legacySynced: true, syncedAt: now,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        synced++;
      }
    }

    if (synced > 0) await batch.commit();
    logger.info(`[SASOS] sasosSyncLegacy: synced ${synced} users`);
    return { success: true, synced };
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  sasosSubscribe,
  sasosCancel,
  sasosGetSubscription,
  sasosListPlans,
  sasosCheckFeature,
  sasosAdminListSubscriptions,
  sasosAdminUpdatePlanConfig,
  sasosExpireTrials,
  sasosProcessRenewals,
  sasosSyncLegacy,
  /* Internal helpers (used by other SASOS modules) */
  _resolvePlan,
  _getActivePlanId,
  _audit,
  _ledger,
  SASOS_PLANS,
  SASOS_PRODUCTS,
  TIER_ORDER,
};
