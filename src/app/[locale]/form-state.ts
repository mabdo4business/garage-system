import type { MessageKey } from "../../i18n";

/**
 * State returned by server actions to the forms that call them (useActionState). Submitted values
 * travel back in this state — never in the URL, which would put customer data into access logs and
 * browser history (I1-01 review finding 11).
 */
export interface FormError {
  key: MessageKey;
  /** Form field the error is about, when the server could tell (ValidationError details.field). */
  field?: string;
  /** Values for the message, e.g. the estimate version in AC2-25's "pending on v{version}". */
  params?: Record<string, string>;
}

export interface FormState<Duplicate = never> {
  /** Bumped on every response; forms use it as a React key so inputs pick up `values` again. */
  seq: number;
  values: Record<string, string>;
  error?: FormError;
  duplicate?: Duplicate;
}

export const EMPTY_FORM_STATE: FormState = { seq: 0, values: {} };

/** Label of each field a ValidationError can name, for "Check “Mobile” and try again". */
export const FIELD_LABELS: Record<string, MessageKey> = {
  name: "customer.new.name",
  mobile: "customer.new.mobile",
  email: "customer.new.email",
  preferredLanguage: "customer.new.language",
  ownerCustomerId: "vehicle.new.owner",
  vin: "vehicle.new.vin",
  make: "vehicle.new.make",
  model: "vehicle.new.model",
  year: "vehicle.new.year",
  colour: "vehicle.new.colour",
  plateEmirate: "vehicle.new.emirate",
  plateCode: "vehicle.new.plateCode",
  plateNumber: "vehicle.new.plateNumber",
  newOwnerCustomerId: "vehicle.profile.newOwnerId",
  // I1-02 check-in
  vehicleId: "checkIn.vehicle",
  contactName: "checkIn.contactName",
  contactMobile: "customer.new.mobile",
  contactRelationship: "checkIn.relationship",
  odometerKm: "checkIn.odometer",
  fuelEighths: "checkIn.fuel",
  warningLights: "checkIn.warningLights",
  concerns: "checkIn.concerns",
  belongings: "checkIn.belongings",
  keysReceived: "checkIn.keysReceived",
  keyTag: "checkIn.keyTag",
  promisedAt: "checkIn.promisedAt",
  photoShortfallReason: "checkIn.shortfallReason",
  abandonedReason: "checkIn.abandonReason",
  excludedReason: "repairOrder.excludeReason",
  photo: "checkIn.section.photos",
  slot: "checkIn.section.photos",
  // I1-03 inspection
  technicianUserId: "inspection.technician",
  title: "finding.title",
  severity: "finding.severity",
  faultCodes: "finding.faultCodes",
  customerNote: "finding.customerNote",
  internalNote: "finding.internalNote",
  templateItemId: "inspection.checklist",
  withdrawnReason: "finding.withdrawReason",
  visibility: "finding.photo",
  // I1-04 catalog & tax
  kind: "catalogue.kind",
  code: "catalogue.code",
  price: "catalogue.price",
  taxCode: "catalogue.taxCode",
  nameEn: "catalogue.nameEn",
  nameAr: "catalogue.nameAr",
  descriptionEn: "catalogue.descriptionEn",
  descriptionAr: "catalogue.descriptionAr",
  partNo: "catalogue.partNo",
  brand: "catalogue.brand",
  partType: "catalogue.partType",
  unit: "catalogue.unit",
  registrationStatus: "tax.status",
  trn: "tax.trn",
  effectiveFrom: "tax.effectiveFrom",
  rate: "tax.rate",
  category: "tax.category",
  labelEn: "catalogue.nameEn",
  labelAr: "catalogue.nameAr",
  note: "tax.note",
  // I1-05 estimate
  itemId: "estimate.item",
  qty: "estimate.qty",
  discount: "estimate.discountAmount",
  reason: "estimate.excludeReason",
  findingId: "estimate.urgentFindings",
  approverName: "approval.name",
  signature: "approval.signature",
  decisions: "approval.title",
  // I1-06 workshop
  assigneeId: "workshop.assignee",
  bay: "workshop.bay",
  pauseReason: "job.pauseReason",
  lines: "job.lines",
  notPerformedReason: "job.line.reason",
  completionNote: "job.note",
  // I1-07 parts
  amount: "stock.amount",
  supplierName: "stock.supplierName",
  supplierRef: "stock.supplierRef",
  overReason: "parts.overReason",
  // I1-08 QC
  noNewWarningLights: "qc.check.noNewWarningLights",
  fluidsOk: "qc.check.fluidsOk",
  cleanlinessOk: "qc.check.cleanlinessOk",
  belongingsOk: "qc.check.belongingsOk",
  roadTest: "qc.roadTest",
  roadTestReason: "qc.roadTestReason",
  odometerOutKm: "qc.odometerOut",
  odometerReason: "qc.odometerReason",
  oldParts: "qc.oldParts",
  notes: "qc.notes",
  jobIds: "qc.returnJobs",
  // I1-09 invoice
  taxChangeNotice: "invoice.taxChangeNotice",
};
