export function createScrollGuard({ idleMs = 120, topTolerance = 1, minJump = 80 } = {}) {
  let stableTop = 0;
  let lastUserScrollAt = Number.NEGATIVE_INFINITY;
  let pendingProgrammaticTop = null;

  const isSameTop = (left, right) => Math.abs(left - right) <= topTolerance;

  return {
    recordInitialTop(top) {
      stableTop = top;
    },

    recordUserScroll(top, at) {
      stableTop = top;

      if (pendingProgrammaticTop !== null && isSameTop(top, pendingProgrammaticTop)) {
        pendingProgrammaticTop = null;
        return;
      }

      pendingProgrammaticTop = null;
      lastUserScrollAt = at;
    },

    recordProgrammaticScroll(top) {
      stableTop = top;
      pendingProgrammaticTop = top;
    },

    getRestoreTarget(currentTop, at) {
      if (stableTop <= topTolerance) return null;
      if (currentTop >= stableTop - topTolerance) return null;
      if (stableTop - currentTop < minJump) return null;
      if (at - lastUserScrollAt < idleMs) return null;
      return stableTop;
    },
  };
}
