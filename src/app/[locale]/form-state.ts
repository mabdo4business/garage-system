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
};
