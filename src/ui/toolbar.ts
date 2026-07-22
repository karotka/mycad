import type { CommandName } from '../core/commands/CommandManager';
import { toolIcon } from './toolIcons';

/**
 * What the toolbar is made of: which tools sit in which group, and the markup for
 * a button and for a flyout. Data and templates only — a flyout is told which
 * tool it last used rather than reaching for it, so nothing here holds state.
 */

export const drawTools: Array<[string, CommandName]> = [
  ['Line', 'LINE'], ['Polyline', 'POLYLINE'], ['Rectangle', 'RECTANGLE'], ['Polygon', 'POLYGON'], ['Arc', 'ARC'], ['Bezier', 'BEZIER'], ['Text', 'TEXT'],
];
export const circleTools: Array<[string, string, CommandName]> = [
  ['Circle', 'Circle by radius', 'CIRCLE'],
  ['Diameter', 'Circle by diameter', 'CIRCLE_DIAMETER'],
  ['Ellipse', 'Ellipse', 'ELLIPSE'],
];
export const modifyTools: Array<[string, CommandName]> = [['Move', 'MOVE'], ['Copy', 'COPY'], ['Mirror', 'MIRROR'], ['Scale', 'SCALE'], ['Rotate', 'ROTATE']];
export const solidTools: Array<[string, CommandName]> = [
  ['Union', 'UNION'], ['Subtract', 'SUBTRACT'], ['PressPull', 'PRESSPULL'],
  ['Chamfer', 'CHAMFER'], ['Fillet', 'FILLET'], ['Slice', 'SLICE'],
];
export const primitiveTools: Array<[string, CommandName]> = [['Box', 'BOX'], ['Wedge', 'WEDGE'], ['Sphere', 'SPHERE'], ['Cone', 'CONE'], ['Cylinder', 'CYLINDER'], ['Pyramid', 'PYRAMID'], ['Torus', 'TORUS']];
export const arrayTools: Array<[string, string, CommandName]> = [['Rectangular', 'Rectangular Array', 'ARRAY_RECTANGULAR'], ['Polar', 'Polar Array', 'ARRAY_POLAR']];
export const extrudeTools: Array<[string, string, CommandName]> = [['Extrude', 'Extrude', 'EXTRUDE'], ['Sweep', 'Sweep Along Path', 'SWEEP']];
export const dimensionTools: Array<[string, string, CommandName]> = [
  ['Linear', 'Linear Dimension — horizontal or vertical', 'MEASURE'],
  ['Aligned', 'Aligned Dimension — the true distance', 'DIMALIGNED'],
  ['Radius', 'Radius Dimension', 'DIMRADIUS'],
  ['Diameter', 'Diameter Dimension', 'DIMDIAMETER'],
];
export const zoomTools: Array<[string, 'ZOOM_ALL' | 'ZOOM_WINDOW']> = [['Zoom All', 'ZOOM_ALL'], ['Zoom Window', 'ZOOM_WINDOW']];
export const editTools: Array<[string, CommandName]> = [
  ['Extend', 'EXTEND'], ['Trim', 'TRIM'], ['Join', 'JOIN'], ['Explode', 'EXPLODE'], ['Offset', 'OFFSET'],
];

export function toolButtons(tools: Array<[string, CommandName]>): string {
  return tools.map(([label, command]) =>
    `<button class="tool-btn" data-command="${command}" data-label="${label}" title="${label}" aria-label="${label}">${toolIcon(command)}</button>`
  ).join('');
}

export function primitiveFlyout(currentPrimitive: CommandName): string {
  const label = primitiveTools.find(([, command]) => command === currentPrimitive)?.[0] ?? 'Box';
  return `<div class="primitive-tool">
    <button class="tool-btn primitive-main" id="primitive-main" data-label="${label}" title="${label} · hold for more" aria-label="${label} · hold for more">${toolIcon(currentPrimitive)}<span class="flyout-caret">▾</span></button>
    <div class="primitive-flyout" id="primitive-flyout" hidden>${primitiveTools.map(([name, command]) => `<button data-primitive-command="${command}" title="${name}">${toolIcon(command)}<span>${name}</span></button>`).join('')}</div>
  </div>`;
}

export function arrayFlyout(): string {
  return `<div class="primitive-tool">
    <button class="tool-btn primitive-main" id="array-main" data-label="Array" title="Array · hold for more" aria-label="Array · hold for more">${toolIcon('ARRAY_RECTANGULAR')}<span class="flyout-caret">▾</span></button>
    <div class="primitive-flyout" id="array-flyout" hidden>${arrayTools.map(([name, tooltip, command]) => `<button data-command="${command}" title="${tooltip}">${toolIcon(command)}<span>${name}</span></button>`).join('')}</div>
  </div>`;
}

export function extrudeFlyout(): string {
  return `<div class="primitive-tool">
    <button class="tool-btn primitive-main" id="extrude-main" data-label="Extrude" title="Extrude · hold for more" aria-label="Extrude · hold for more">${toolIcon('EXTRUDE')}<span class="flyout-caret">▾</span></button>
    <div class="primitive-flyout" id="extrude-flyout" hidden>${extrudeTools.map(([name, tooltip, command]) => `<button data-command="${command}" title="${tooltip}">${toolIcon(command)}<span>${name}</span></button>`).join('')}</div>
  </div>`;
}

export function circleFlyout(currentCircle: CommandName): string {
  const current = circleTools.find(([, , command]) => command === currentCircle) ?? ['Circle', 'Circle by radius', 'CIRCLE'] as const;
  const [label, tooltip] = current;
  return `<div class="primitive-tool"><button class="tool-btn primitive-main" id="circle-main" data-label="${label}" title="${tooltip} · hold for more" aria-label="${tooltip} · hold for more">${toolIcon(currentCircle)}<span class="flyout-caret">▾</span></button><div class="primitive-flyout" id="circle-flyout" hidden>${circleTools.map(([name, tooltipText, command]) => `<button data-circle-command="${command}" title="${tooltipText}">${toolIcon(command)}<span>${name}</span></button>`).join('')}</div></div>`;
}

export function dimensionFlyout(currentDimension: CommandName): string {
  const current = dimensionTools.find(([, , command]) => command === currentDimension) ?? ['Linear', 'Linear Dimension', 'MEASURE'] as const;
  const [label, tooltip] = current;
  return `<div class="primitive-tool"><button class="tool-btn primitive-main" id="dimension-main" data-label="${label}" title="${tooltip} · hold for more" aria-label="${tooltip} · hold for more">${toolIcon(currentDimension)}<span class="flyout-caret">▾</span></button><div class="primitive-flyout" id="dimension-flyout" hidden>${dimensionTools.map(([name, tooltipText, command]) => `<button data-dimension-command="${command}" title="${tooltipText}">${toolIcon(command)}<span>${name}</span></button>`).join('')}</div></div>`;
}

export function zoomFlyout(currentZoom: 'ZOOM_ALL' | 'ZOOM_WINDOW'): string {
  const label = zoomTools.find(([, action]) => action === currentZoom)?.[0] ?? 'Zoom All';
  return `<div class="primitive-tool"><button class="tool-btn primitive-main" id="zoom-main" data-label="${label}" title="${label} · hold for more" aria-label="${label} · hold for more">${toolIcon(currentZoom)}<span class="flyout-caret">▾</span></button><div class="primitive-flyout" id="zoom-flyout" hidden>${zoomTools.map(([name, action]) => `<button data-zoom-command="${action}" title="${name}">${toolIcon(action)}<span>${name}</span></button>`).join('')}</div></div>`;
}
