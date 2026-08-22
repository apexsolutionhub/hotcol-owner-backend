import { gql } from "apollo-server-express";

export const typeDefs = gql`
  scalar DateTime
  scalar JSON

  type Owner {
    id: Int!
    UserName: String!
    displayName: String
    phone: String
    email: String
    propertyCount: Int!
  }

  type OwnerAuthPayload {
    token: String!
    owner: Owner!
  }

  type CategoryRevenue {
    label: String!
    revenueETB: Float!
  }

  type RevenueSnapshot {
    todayRevenueETB: Float!
    monthRevenueETB: Float!
    todayOrders: Int!
    todayCashETB: Float!
    todayBankETB: Float!
    todayCreditETB: Float!
    categories: [CategoryRevenue!]!
  }

  "Estimated café profit from menu recipe ingredient costs."
  type CafeProfitSnapshot {
    todayRevenueETB: Float!
    todayIngredientCostETB: Float!
    todayProfitETB: Float!
    todayMarginPct: Float!
    monthRevenueETB: Float!
    monthIngredientCostETB: Float!
    monthProfitETB: Float!
    monthMarginPct: Float!
    linesWithRecipe: Int!
    paidLines: Int!
    recipeCoveragePct: Int!
    menuItemsWithRecipe: Int!
    menuItemCount: Int!
  }

  type DailyCafePoint {
    date: String!
    label: String!
    revenueETB: Float!
    ingredientCostETB: Float!
    profitETB: Float!
    orders: Int!
  }

  type CategoryProfit {
    label: String!
    revenueETB: Float!
    ingredientCostETB: Float!
    profitETB: Float!
  }

  type CafeSoldRanking {
    label: String!
    quantity: Float!
    revenueETB: Float!
    profitETB: Float!
  }

  type CafeOrderSummary {
    totalLines: Int!
    completed: Int!
    completedETB: Float!
    cancelled: Int!
    cancelledETB: Float!
    pendingPayment: Int!
    pendingPaymentETB: Float!
    expired: Int!
    expiredETB: Float!
  }

  type CafeAnalytics {
    profit: CafeProfitSnapshot!
    dailyTrend: [DailyCafePoint!]!
    topCategories: [CategoryProfit!]!
    topSoldByCategory: [CafeSoldRanking!]!
    topSoldByType: [CafeSoldRanking!]!
    topSoldItems: [CafeSoldRanking!]!
    orderSummary: CafeOrderSummary!
  }

  "Daily or Monthly café report for a selected calendar date/month."
  type CafePeriodReport {
    period: String!
    date: String!
    label: String!
    revenueETB: Float!
    ingredientCostETB: Float!
    profitETB: Float!
    marginPct: Float!
    cashETB: Float!
    bankETB: Float!
    creditETB: Float!
    paidLines: Int!
    linesWithRecipe: Int!
    recipeCoveragePct: Int!
    menuItemsWithRecipe: Int!
    menuItemCount: Int!
    categories: [CategoryProfit!]!
    topSoldByCategory: [CafeSoldRanking!]!
    topSoldByType: [CafeSoldRanking!]!
    topSoldItems: [CafeSoldRanking!]!
    orderSummary: CafeOrderSummary!
    trend: [DailyCafePoint!]!
  }

  type ApprovalPipelineCounts {
    pendingCC: Int!
    checkedCC: Int!
    pendingFinance: Int!
    pendingManager: Int!
    authorized: Int!
  }

  type OperationalSnapshot {
    staffCount: Int!
    ordersToday: Int!
    openOrders: Int!
    pendingPurchaseRequests: Int!
    pendingStockOutRequests: Int!
    pendingItemRegistrations: Int!
    purchaseRequestPipeline: ApprovalPipelineCounts
    stockOutRequestPipeline: ApprovalPipelineCounts
    itemRegistrationPipeline: ApprovalPipelineCounts
  }

  "Room occupancy, CM queue, stays, and guest-bill service revenue."
  type LodgingSnapshot {
    vacantClean: Int!
    vacantDirty: Int!
    occupied: Int!
    onMaintenance: Int!
    totalRooms: Int!
    activeStays: Int!
    reservedStays: Int!
    openCmAssignments: Int!
    openCleaning: Int!
    openMaintenance: Int!
    occupancyPct: Int!
    readyPct: Int!
    todayRoomRevenueETB: Float!
    todayFoodDrinkETB: Float!
    todayLaundryETB: Float!
    todayOtherServicesETB: Float!
    monthStayRevenueETB: Float!
    openFolioETB: Float!
    checkInsToday: Int!
    checkOutsToday: Int!
    roomServiceOpenOrders: Int!
    roomServiceOrdersToday: Int!
  }

  "Café floor readiness (menu / tables / waiters)."
  type CafeOpsSnapshot {
    menuItemCount: Int!
    tableCount: Int!
    waiterCount: Int!
    cancelledToday: Int!
  }

  type ModuleHealthMetric {
    label: String!
    value: String!
  }

  "Per-subscribed-module owner scorecard (mirrors tenant Manager overview)."
  type ModuleHealth {
    module: String!
    label: String!
    score: Int!
    alertLevel: String!
    summary: String!
    metrics: [ModuleHealthMetric!]!
  }

  type BillingInfo {
    subscriptionStatus: String!
    setupFeeETB: Int!
    quarterlyFeeETB: Int!
    renewalAmountETB: Int!
    renewalKind: String!
    setupFeeApproved: Boolean!
    subscriptionPaymentApproved: Boolean!
    subscriptionPaidUntil: DateTime
    paidQuartersCount: Int!
    billingHold: Boolean!
    isIllustrationTenant: Boolean!
    freeTrialEndsAt: DateTime
    pendingPaymentKind: String
  }

  "A single property card in the owner's portfolio."
  type OwnerProperty {
    tinNumber: String!
    label: String
    hotelDisplayName: String!
    businessType: String
    logoUrl: String
    accountStatus: String!
    subscriptionStatus: String!
    accessBlocked: Boolean!
    accessBlockReason: String
    modules: JSON
    todayRevenueETB: Float!
    monthRevenueETB: Float!
    openOrders: Int!
    pendingApprovals: Int!
    staffCount: Int!
    needsAttention: Boolean!
    occupancyPct: Int
    vacantDirty: Int
    openCmAssignments: Int
    activeStays: Int
  }

  type PortfolioSummary {
    propertyCount: Int!
    todayRevenueETB: Float!
    monthRevenueETB: Float!
    openOrders: Int!
    pendingApprovals: Int!
    attentionCount: Int!
    occupiedRooms: Int!
    openCmJobs: Int!
    properties: [OwnerProperty!]!
  }

  type PropertyDashboard {
    tinNumber: String!
    hotelDisplayName: String!
    businessType: String
    logoUrl: String
    accountStatus: String!
    subscriptionStatus: String!
    accessBlocked: Boolean!
    accessBlockReason: String
    modules: JSON
    allowedRoles: [String!]!
    revenue: RevenueSnapshot!
    operational: OperationalSnapshot!
    lodging: LodgingSnapshot
    cafeOps: CafeOpsSnapshot
    cafeAnalytics: CafeAnalytics
    moduleHealth: [ModuleHealth!]!
    billing: BillingInfo!
  }

  type StaffMember {
    id: Int!
    UserName: String!
    Role: String!
    loginDisabled: Boolean!
    loginDisabledReason: String
    createdAt: DateTime
  }

  type WaiterRow {
    id: Int!
    name: String!
    sex: String
    age: Int
    experience: Int
    phoneNumber: String
    completedOrders: Int!
    totalSalesETB: Float!
  }

  type InventoryItem {
    id: Int!
    name: String!
    category: String
    amount: Float!
    measuredBy: String
    unitPrice: Float!
    totalValueETB: Float!
    expireDate: DateTime
    supplierName: String
    approvalStatus: String
  }

  type InventorySummary {
    itemCount: Int!
    totalValueETB: Float!
    expiringSoon: Int!
    items: [InventoryItem!]!
  }

  type PaymentRow {
    id: Int!
    tinNumber: String!
    paymentKind: String!
    amountETB: Int!
    paymentChannel: String!
    transactionRef: String!
    status: String!
    submittedAt: DateTime!
    approvedAt: DateTime
    rejectedAt: DateTime
    rejectionReason: String
    quarterNumber: Int
  }

  type DepartmentLeaderRow {
    id: Int!
    department: String!
    departmentLabel: String!
    leaderName: String!
  }

  type CostControllerRow {
    id: Int!
    displayName: String!
    createdAt: DateTime
  }

  "Department leaders + cost-controller IDs (inventory / hotel store workflow)."
  type InventoryPeopleSummary {
    departmentLeaders: [DepartmentLeaderRow!]!
    costControllers: [CostControllerRow!]!
  }

  type Query {
    ownerMe: Owner
    portfolio: PortfolioSummary!
    propertyDashboard(tinNumber: String!): PropertyDashboard
    propertyCafeReport(
      tinNumber: String!
      period: String!
      date: String!
    ): CafePeriodReport
    propertyStaff(tinNumber: String!): [StaffMember!]!
    propertyWaiters(tinNumber: String!): [WaiterRow!]!
    propertyInventory(tinNumber: String!, limit: Int): InventorySummary!
    propertyInventoryPeople(tinNumber: String!): InventoryPeopleSummary!
    propertyPayments(tinNumber: String!, limit: Int): [PaymentRow!]!
  }

  type TenantModuleChangeRequest {
    id: Int!
    tinNumber: String!
    status: String!
    requestedBySide: String!
    requestNote: String
    requestedModules: JSON
    createdAt: DateTime!
  }

  type Mutation {
    ownerLogin(UserName: String!, Password: String!): OwnerAuthPayload!
    ownerChangePassword(currentPassword: String!, newPassword: String!): Boolean!
    ownerCreateStaff(
      tinNumber: String!
      UserName: String!
      Password: String!
      Role: String!
    ): StaffMember!
    ownerSetStaffPassword(userId: Int!, Password: String!): Boolean!
    ownerSetStaffLoginDisabled(
      userId: Int!
      disabled: Boolean!
      reason: String
    ): Boolean!
    ownerSubmitSubscriptionPayment(
      tinNumber: String!
      paymentKind: String!
      paymentChannel: String!
      transactionRef: String!
    ): PaymentRow!
    """
    Portfolio owner: request adding or removing subscribed modules for a property.
    Creates a pending tenant_module_change_request for Apex review.
    """
    ownerRequestModuleChange(
      tinNumber: String!
      changeType: String!
      modules: JSON!
      requestNote: String
    ): TenantModuleChangeRequest!
  }
`;
