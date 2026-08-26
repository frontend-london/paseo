import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { AlertTriangle } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { resolveProviderDrillDownState } from "@/components/model-browser-view";
import type { ProviderModelSelection } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function ProviderDrillDownTrailingState({
  selection,
}: {
  selection: ProviderModelSelection;
}) {
  const { t } = useTranslation();
  const drillDownState = useMemo(() => resolveProviderDrillDownState(selection), [selection]);

  if (drillDownState.kind === "healthy") {
    const count = drillDownState.modelCount;
    return (
      <Text style={styles.drillDownCount}>
        {t(count === 1 ? "modelSelector.modelCount" : "modelSelector.modelCountPlural", {
          count,
        })}
      </Text>
    );
  }

  if (drillDownState.kind === "stale") {
    const staleNode = (
      <View style={styles.rowStateInline} testID="model-provider-stale-state">
        <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        <Text style={styles.drillDownCount}>{t("modelSelector.stale")}</Text>
      </View>
    );
    if (drillDownState.refreshError) {
      return (
        <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>{staleNode}</TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{drillDownState.refreshError}</Text>
          </TooltipContent>
        </Tooltip>
      );
    }
    return staleNode;
  }

  if (drillDownState.kind === "loading") {
    return (
      <View style={styles.rowStateInline}>
        <View style={styles.rowSpinner}>
          <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        </View>
        <Text style={styles.drillDownCount}>{t("modelSelector.loadingShort")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.rowStateInline}>
      <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      <Text style={styles.drillDownCount}>{t("modelSelector.error")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  drillDownCount: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowStateInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  rowSpinner: {
    transform: [{ scale: 0.7 }],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
