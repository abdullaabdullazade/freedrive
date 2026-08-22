import { useWindowDimensions } from "react-native";
import { RAIL_WIDTH } from "../components/SideNav";
import { spacing } from "../theme";
import { useWideLayout } from "./useWideLayout";

const MIN_TILE = 160;
/** Horizontal padding around the grid (matches screen content padding). */
const GRID_H_PAD = spacing.lg * 2;

/**
 * Column count so grid tiles stay roughly phone-sized on wide / landscape screens.
 */
export function useGridColumns(): number {
  const { width } = useWindowDimensions();
  const isLandscape = useWideLayout();
  const contentWidth = width - (isLandscape ? RAIL_WIDTH : 0) - GRID_H_PAD;
  return Math.max(2, Math.floor(contentWidth / MIN_TILE));
}
