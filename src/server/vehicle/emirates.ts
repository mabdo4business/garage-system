import type { Emirate } from "../db/schema";

/** The seven emirates, in the order forms list them. No server imports: client forms use it too. */
export const EMIRATES: readonly Emirate[] = [
  "abu_dhabi",
  "dubai",
  "sharjah",
  "ajman",
  "umm_al_quwain",
  "ras_al_khaimah",
  "fujairah",
];
