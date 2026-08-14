'use client';

import type { EChartsOption } from 'echarts';

import { ReactEChartsCore } from './echarts-core';
import { WHEEL } from './palette';

export interface Slice {
  name: string;
  value: number;
}

/**
 * A doughnut with the total in the hole.
 *
 * Client-only because ECharts needs the DOM to size and paint. The Server
 * Component that renders the surrounding card computes the slices and hands
 * them down as a plain, serialisable array — no echarts import crosses onto the
 * server, no data fetching crosses onto the client.
 */
export function DonutChart({
  slices,
  centerLabel,
  unit,
}: {
  slices: Slice[];
  centerLabel: string;
  unit?: string;
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  const option: EChartsOption = {
    color: [...WHEEL],
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const point = p as { name: string; value: number; percent: number };
        return `${point.name}<br/><b>${point.value.toLocaleString('en-IN')}</b>${
          unit ? ` ${unit}` : ''
        } · ${point.percent}%`;
      },
    },
    legend: {
      orient: 'vertical',
      right: 4,
      top: 'center',
      itemWidth: 9,
      itemHeight: 9,
      icon: 'circle',
      textStyle: { color: '#6a6880', fontSize: 12 },
    },
    series: [
      {
        type: 'pie',
        radius: ['58%', '82%'],
        center: ['34%', '50%'],
        avoidLabelOverlap: false,
        itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 2 },
        label: {
          show: true,
          position: 'center',
          formatter: () => `{v|${total.toLocaleString('en-IN')}}\n{l|${centerLabel}}`,
          rich: {
            v: { fontSize: 24, fontWeight: 700, color: '#14131f' },
            l: { fontSize: 12, color: '#9997ac', padding: [4, 0, 0, 0] },
          },
        },
        emphasis: {
          label: { show: true },
          scaleSize: 4,
        },
        labelLine: { show: false },
        data: slices,
      },
    ],
  };

  return (
    <ReactEChartsCore option={option} style={{ height: 260 }} opts={{ renderer: 'svg' }} notMerge />
  );
}
