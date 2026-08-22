/** Café recipe / profit math — mirrors hotcol-user lib/cafeRecipe.ts */

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function parseMenuRecipe(raw) {
  if (!raw || typeof raw !== "object") return null;
  const ingredients = raw.ingredients;
  if (!Array.isArray(ingredients) || ingredients.length === 0) return null;

  const parsed = [];
  for (const row of ingredients) {
    if (!row || typeof row !== "object") continue;
    const name = String(row.name ?? "").trim();
    if (!name) continue;
    parsed.push({
      name,
      amount: asNumber(row.amount),
      measuredBy: String(row.measuredBy ?? "").trim(),
      unitPrice: asNumber(row.unitPrice),
    });
  }
  return parsed.length > 0 ? { ingredients: parsed } : null;
}

export function recipeCostPerUnit(recipe) {
  return recipe.ingredients.reduce(
    (sum, line) => sum + line.amount * line.unitPrice,
    0,
  );
}

export function orderLineIngredientCost(recipe, orderAmount) {
  const qty = Math.max(0, Number(orderAmount) || 0);
  return recipeCostPerUnit(recipe) * qty;
}

export function findItemRecipeByTitle(items, title) {
  const key = String(title ?? "").trim().toLowerCase();
  if (!key) return null;
  const item = items.find((i) => String(i.name ?? "").trim().toLowerCase() === key);
  return item ? parseMenuRecipe(item.recipeJson) : null;
}

function hasSnapshottedUnitCost(order) {
  return (
    order?.unitCostAtSale != null &&
    Number.isFinite(Number(order.unitCostAtSale))
  );
}

/**
 * Prefer `unitCostAtSale` frozen on the order; fall back to live recipe for
 * legacy rows created before cost snapshotting.
 */
export function orderLineResolvedIngredientCost(order, recipe) {
  const qty = Math.max(0, Number(order?.orderAmount) || 0);
  if (hasSnapshottedUnitCost(order)) {
    return Number(order.unitCostAtSale) * qty;
  }
  if (!recipe) return null;
  return orderLineIngredientCost(recipe, order.orderAmount);
}
