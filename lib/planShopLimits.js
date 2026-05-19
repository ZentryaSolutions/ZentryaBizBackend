/**
 * Shop limits per subscription plan (keep in sync with frontend planFeatures + stripeWebhook).
 * trial / growth (pro) / starter → 1 shop
 * business (premium) → unlimited (99999 cap)
 * expired → 0 new shops
 */

function shopLimitForPlan(plan) {
  const p = String(plan || 'trial').toLowerCase();
  if (p === 'expired') return 0;
  if (p === 'premium') return 99999;
  return 1;
}

function isUnlimitedShopLimit(limit) {
  const n = Number(limit);
  return Number.isFinite(n) && n >= 9999;
}

function resolveShopLimit(profileRow) {
  if (profileRow?.shop_limit != null && profileRow.shop_limit !== '') {
    const n = Number(profileRow.shop_limit);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return shopLimitForPlan(profileRow?.plan);
}

module.exports = {
  shopLimitForPlan,
  isUnlimitedShopLimit,
  resolveShopLimit,
};
