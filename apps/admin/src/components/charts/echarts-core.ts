'use client';

/**
 * Tree-shaken ECharts entry. Importing `echarts-for-react` (or `echarts`)
 * whole pulls the entire chart/renderer set — ~600-800 KB — when the admin only
 * ever draws a pie and a line, both as SVG. Registering just those keeps the
 * bundle to what is actually painted. Every chart component imports its renderer
 * from here, never from `echarts-for-react` directly.
 */
import { use } from 'echarts/core';
import { PieChart, LineChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import ReactEChartsCore from 'echarts-for-react/lib/core';

use([PieChart, LineChart, TooltipComponent, LegendComponent, GridComponent, SVGRenderer]);

export { ReactEChartsCore };
