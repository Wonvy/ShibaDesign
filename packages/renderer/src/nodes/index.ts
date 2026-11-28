import { NodeTypeRegistry } from '../node-types';
import { booleanType } from './boolean';
import { artboardType, groupType, pageType } from './containers';
import { ellipseType, frameType, pathType, polygonType, rectType } from './shapes';

/** 注册所有内置节点类型 */
export function registerBuiltinNodeTypes(registry: NodeTypeRegistry): NodeTypeRegistry {
  return registry
    .register(pageType)
    .register(artboardType)
    .register(groupType)
    .register(frameType)
    .register(rectType)
    .register(ellipseType)
    .register(polygonType)
    .register(pathType)
    .register(booleanType);
}

export { booleanFailures, toPathOp, transformed } from './boolean';
export { boxOutline, buildPath } from './shapes';
