import { apiGet } from "./debug-api";
import {
  modelInstructionCardsPath,
  type ModelInstructionCardsState,
} from "./model-instruction-cards";

export function getModelInstructionCards(): Promise<ModelInstructionCardsState> {
  return apiGet<ModelInstructionCardsState>(modelInstructionCardsPath());
}
