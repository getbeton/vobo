import '@testing-library/react';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no layout engine, so scrollIntoView is undefined on every element.
// The component calls it when the composer opens; without this stub the call
// throws and the test would fail for the wrong reason.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

afterEach(() => cleanup());
