'use client';

/**
 * Tree-shaken ECharts entry. Importing `echarts-for-react` (or `echarts`)
 * whole pulls the entire chart/renderer set — ~600-800 KB — when the admin only
 * ever draws a pie and a line, both as SVG. Registering just those keeps the
 * bundle to what is actually painted. Every chart component imports its renderer
 * from here, never from `echarts-for-react` directly.
 */
// Aliased: ECharts' registrar is named `use`, which the React hooks lint rule
// flags as a hook called at the top level. It is not a hook — it is the
// tree-shaking registration below — so the alias both silences the false
// positive and reads as what it does.
import { use as registerECharts } from 'echarts/core';
import { PieChart, LineChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import ReactEChartsCore from 'echarts-for-react/lib/core';

registerECharts([
  PieChart,
  LineChart,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  SVGRenderer,
]);

export { ReactEChartsCore };
