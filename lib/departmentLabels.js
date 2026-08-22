/** Hotel department codes — mirrors hotcol-user departmentLeaders.js */

const DEPARTMENT_LABELS = {
  KITCHEN: "Kitchen",
  BAR: "Bar",
  HOUSE_KEEPING_ROOM: "House Keeping (Room)",
  HOUSE_KEEPING_PUBLIC: "House Keeping (Public)",
  HOUSE_KEEPING: "House Keeping (Room)",
  SECURITY: "Security",
  MAINTENANCE: "Maintenance",
  FINANCE: "Finance",
  HR: "Human Resource (HR)",
  GM: "General Manager (GM)",
  FB_SERVICE: "Food and Beverage Service (F&B service)",
  STORE: "Store",
  STAFF: "Staff",
};

export function departmentLabel(code) {
  const key = String(code ?? "").trim();
  if (!key) return "—";
  if (key === "HOUSE_KEEPING") return DEPARTMENT_LABELS.HOUSE_KEEPING_ROOM;
  return DEPARTMENT_LABELS[key] ?? key;
}
