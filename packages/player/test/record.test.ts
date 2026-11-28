import { describe, expect, it } from 'vitest';
import { estimateDuration, type PresentationData } from '../src';

const animation = (start: number, duration: number) => ({
  layer: 'a',
  start,
  duration,
  easing: 'linear',
  show: false,
  hide: false,
});

describe('录视频的时长估计', () => {
  it('每页：切换 + 每一步的动画（单击的步骤前面等一会儿）+ 停留', () => {
    const data: PresentationData = {
      title: '',
      slides: [
        {
          width: 1280,
          height: 720,
          background: '#fff',
          layers: [],
          // 第 0 步自动播放 800ms；第 1 步单击开始，两条动画最晚的在 1300ms 结束
          steps: [[animation(0, 800)], [animation(0, 700), animation(700, 600)]],
          transition: { effect: 'none', duration: 0 },
        },
        {
          width: 1280,
          height: 720,
          background: '#fff',
          layers: [],
          steps: [[]],
          transition: { effect: 'push', duration: 600 },
        },
      ],
    };
    expect(estimateDuration(data, { dwell: 1000, clickDelay: 500 })).toBe(800 + 500 + 1300 + 1000 + 600 + 1000);
  });
});
