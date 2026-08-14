'use client';

import type { EChartsOption } from 'echarts';
import { useState } from 'react';

import { ReactEChartsCore } from './echarts-core';
import { PALETTE } from './palette';

export interface TrendDay {
  day: string;
  newProfiles: number;
  newExpenses: number;
  active: number;
}

type Metric = 'newProfiles' | 'newExpenses' | 'active';

const SERIES: Record<Metric, { label: string; color: string }> = {
  newProfiles: { label: 'New people', color: PALETTE.purple },
  newExpenses: { label: 'Expenses', color: PALETTE.blue },
  active: { label: 'Active', color: PALETTE.green },
};

const ORDER: Metric[] = ['newProfiles', 'newExpenses', 'active'];

/**
 * One smooth area over the 30-day series, with a segmented switch to change
 * which count it draws. The switch is why this owns its card head rather than
 * being handed a bare `<div>`: the button state and the chart have to live on
 * the same side of the server/client line.
 */
export function AreaTrend({ days }: { days: TrendDay[] }) {
  const [metric, setMetric] = useState<Metric>('newProfiles');
  const active = SERIES[metric];

  const option: EChartsOption = {
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#c9c7dd' } },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: days.map((d) => d.day.slice(5)), // MM-DD; the year is the same 30 days
      axisLine: { lineStyle: { color: '#e6e5ef' } },
      axisTick: { show: false },
      axisLabel: { color: '#9997ac', fontSize: 11, interval: 4 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#eeedf5' } },
      axisLabel: { color: '#9997ac', fontSize: 11 },
    },
    series: [
      {
        type: 'line',
        smooth: true,
        symbol: 'none',
        name: active.label,
        data: days.map((d) => d[metric]),
        lineStyle: { width: 2.5, color: active.color },
        itemStyle: { color: active.color },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${active.color}55` },
              { offset: 1, color: `${active.color}05` },
            ],
          },
        },
      },
    ],
  };

  return (
    <>
      <div className="card-head">
        <h3>Activity, 30 days</h3>
        <div className="seg" role="group" aria-label="Which series">
          {ORDER.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={metric === key}
              onClick={() => setMetric(key)}
            >
              {SERIES[key].label}
            </button>
          ))}
        </div>
      </div>
      <div className="echart">
        <ReactEChartsCore
          option={option}
          style={{ height: 240 }}
          opts={{ renderer: 'svg' }}
          notMerge
        />
      </div>
    </>
  );
}
