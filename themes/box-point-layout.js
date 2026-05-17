const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function percentile(sortedValues, ratio) {
    if (sortedValues.length === 0)
        return 0;
    if (sortedValues.length === 1)
        return sortedValues[0];
    const position = clamp(ratio, 0, 1) * (sortedValues.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper)
        return sortedValues[lower];
    const mix = position - lower;
    return sortedValues[lower] * (1 - mix) + sortedValues[upper] * mix;
}
function axisStats(values, targetHalfExtent) {
    const sorted = [...values].sort((a, b) => a - b);
    let low = percentile(sorted, 0.02);
    let high = percentile(sorted, 0.98);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low < 1e-5) {
        low = sorted[0] ?? -1;
        high = sorted[sorted.length - 1] ?? 1;
    }
    const center = (low + high) * 0.5;
    const halfRange = Math.max((high - low) * 0.5, 1e-5);
    return {
        center,
        scale: targetHalfExtent / halfRange
    };
}
export function buildExpandedBoxPointPositions(points, targetHalfExtent) {
    const positions = new Float32Array(points.length * 3);
    if (points.length === 0)
        return positions;
    const target = Math.max(0.001, targetHalfExtent);
    const xs = points.map(([, x]) => x);
    const ys = points.map(([, , y]) => y);
    const zs = points.map(([, , , z]) => z);
    const stats = [axisStats(xs, target), axisStats(ys, target), axisStats(zs, target)];
    const expand = (value, axis) => {
        const normalized = clamp((value - axis.center) * axis.scale / target, -1, 1);
        return Math.sign(normalized) * Math.pow(Math.abs(normalized), 0.72) * target;
    };
    points.forEach(([, x, y, z], index) => {
        positions[index * 3] = expand(x, stats[0]);
        positions[index * 3 + 1] = expand(y, stats[1]);
        positions[index * 3 + 2] = expand(z, stats[2]);
    });
    return positions;
}
