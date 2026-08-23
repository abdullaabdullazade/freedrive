import { useWindowDimensions } from "react-native";

/**
 * Landscape chrome (NavRail) for phone rotate + tablet landscape.
 * Portrait — including tablet portrait — uses phone bottom tabs.
 */
export function useWideLayout(): boolean {
  const { width, height } = useWindowDimensions();
  return width > height;
}
