import React from "react";
import Svg, { Path } from "react-native-svg";

// Same artwork as desktop/public/logo.svg (viewBox 0 0 87.3 78)
interface LogoProps {
  size?: number;
}

export function Logo({ size = 32 }: LogoProps) {
  const height = (size * 78) / 87.3;
  return (
    <Svg width={size} height={height} viewBox="0 0 87.3 78">
      <Path d="M6.6 66.85L3.3 61.35 29.1 17 35.7 17 10 61.35z" fill="#0066DA" />
      <Path d="M43.65 25L29.1 0 58.2 0 72.8 25z" fill="#00AC47" />
      <Path d="M72.8 25L87.3 50 58.2 78 43.7 53z" fill="#EA4335" />
      <Path d="M43.65 25L29.1 50 0 50 14.5 25z" fill="#2684FC" />
      <Path d="M43.65 25L58.2 50 29.1 50z" fill="#00832D" />
      <Path d="M72.8 25L87.3 50 58.2 50z" fill="#FFBA00" />
    </Svg>
  );
}
