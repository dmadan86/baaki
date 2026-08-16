'use client';

/**
 * Tree-shaken ECharts entry. Importing `echarts-for-react` (or `echarts`)
 * whole pulls the entire chart/renderer set — ~600-800 KB — when the admin only
 * ever draws a pie and a line, both as SVG. Registering just those keeps the
 * bundle to what is actually painted. Every chart component imports its renderer
 * from here, never from `echarts-for-react` directly.
 */
// Namespace import: `echarts-for-react/lib/core` calls `props.echarts.init(...)`
// on mount, so it needs the same registered core namespace the charts were
// registered against. The wrapper below injects it so no call site has to.
import * as echarts from 'echarts/core';
import { PieChart, LineChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import ReactEChartsCoreBase from 'echarts-for-react/lib/core';
import { createElement, type ComponentProps } from 'react';

// `use` is ECharts' registrar; it is not a React hook despite the name, so the
// tree-shaking registration below is a plain call.
echarts.use([PieChart, LineChart, TooltipComponent, LegendComponent, GridComponent, SVGRenderer]);

export function ReactEChartsCore(
  props: Omit<ComponentProps<typeof ReactEChartsCoreBase>, 'echarts'>,
) {
  return createElement(ReactEChartsCoreBase, { echarts, ...props });
}
