import { clone, each, isEmpty, isNumber } from '@antv/util';
import { ID, IG6GraphEvent } from '../../types';
import { Behavior } from '../../types/behavior';

const VALID_TRIGGERS = ['wheel', 'upDownKeys'];
export interface ZoomCanvasOptions {
  /**
   * Whether enable optimize strategies, which will hide all the shapes excluding node keyShape while zooming.
   * TODO: optimize when trigger is upDownKeys
   */
  enableOptimize?: boolean;
  /**
   * Whether allow trigger this behavior when wheeling start on nodes / edges / combos.
   */
  triggerOnItems?: boolean;
  /**
   * The trigger for the behavior, 'wheel' by default. 'upDownKeys' means trigger this behavior by up / down keys on keyboard.
   */
  trigger?: 'wheel' | 'upDownKeys';
  /**
   * The assistant secondary key on keyboard. If it is not assigned, the behavior will be triggered when trigger happens.
   */
  secondaryKey?: string;
  /**
   * The key on keyboard to speed up translating while pressing and zoom-canvas by direction keys. The trigger should be 'directionKeys' for this option.
   */
  speedUpKey?: string;
  /**
   * The sensitivity / speed of zooming.
   */
  sensitivity?: number;
  /**
   * The event name to trigger when zoom end.
   */
  eventName?: string;
  /**
   * The min value of zoom ratio to constrain the zoom-canvas-3d behavior
   */
  minZoom?: number;
  /**
   * The max value of zoom ratio to constrain the zoom-canvas-3d behavior
   */
  maxZoom?: number;
  /**
   * Whether allow the behavior happen on the current item.
   */
  shouldBegin?: (event: IG6GraphEvent) => boolean;
  /**
   * Configuration for fixing selected items' properties while zooming the canvas
   */
  fixSelectedItems?: Partial<{
    // Whether to fix the overall size of the elements. Takes priority over fixKeyShape and fixLabel
    fixAll: boolean;
    // Whether to fix the keyShape of the elements.
    fixKeyShape: boolean;
    // Whether to fix the label size of the elements.
    fixLabel: boolean;
    // IDs of shapes would be fixed
    shapeIds: string[];
  }>;
  // TODO: optimizeZoom
  // optimizeZoom: hide shapes when zoom ratio is smaller than optimizeZoom
}

const DEFAULT_OPTIONS: Required<ZoomCanvasOptions> = {
  enableOptimize: undefined,
  triggerOnItems: true,
  sensitivity: 2,
  trigger: 'wheel',
  secondaryKey: '',
  speedUpKey: 'shift',
  eventName: '',
  minZoom: 0.00001,
  maxZoom: 1000,
  shouldBegin: () => true,
  fixSelectedItems: {},
};

export class ZoomCanvas extends Behavior {
  private zooming: boolean; // pointerdown + pointermove a distance
  private keydown: boolean;
  private speedupKeydown: boolean;
  private hiddenEdgeIds: ID[];
  private hiddenNodeIds: ID[];
  private zoomTimer: ReturnType<typeof setTimeout>;
  private tileRequestId?: number;

  constructor(options: Partial<ZoomCanvasOptions>) {
    const finalOptions = Object.assign({}, DEFAULT_OPTIONS, options);
    if (!VALID_TRIGGERS.includes(finalOptions.trigger)) {
      console.warn(
        `The trigger ${finalOptions.trigger} is not valid, 'wheel' will take effect.`,
      );
      finalOptions.trigger = 'wheel';
    }
    if (finalOptions.fixSelectedItems) {
      let newShapeIds = finalOptions.fixSelectedItems.shapeIds || [];
      if (finalOptions.fixSelectedItems.fixLabel) {
        newShapeIds.push('labelShape', 'labelBackgroundShape');
      }
      if (finalOptions.fixSelectedItems.fixKeyShape) {
        newShapeIds.push('keyShape');
      }
      if (finalOptions.fixSelectedItems.fixAll) {
        finalOptions.fixSelectedItems.fixLabel = true;
        finalOptions.fixSelectedItems.fixKeyShape = true;
        newShapeIds = [];
      }
      finalOptions.fixSelectedItems.shapeIds = newShapeIds;
    }
    super(finalOptions);
  }

  getEvents() {
    this.graph.canvas
      .getContextService()
      .getDomElement()
      .addEventListener?.(
        'wheel',
        (e) => {
          e.preventDefault();
        },
        { passive: false },
      );

    if (this.options.trigger === 'upDownKeys') {
      return {
        keydown: this.onKeydown,
        keyup: this.onKeyup,
      };
    }
    return {
      wheel: this.onWheel,
      keydown: this.onKeydown,
      keyup: this.onKeyup,
    };
  }

  private hideShapes() {
    const { graph } = this;
    const { tileBehavior: graphBehaviorOptimize, tileBehaviorSize = 1000 } =
      graph.getSpecification().optimize || {};
    const optimize =
      this.options.enableOptimize !== undefined
        ? this.options.enableOptimize
        : graphBehaviorOptimize;
    const shouldOptimze = isNumber(optimize)
      ? graph.getAllNodesData().length > optimize
      : optimize;
    if (shouldOptimze) {
      this.hiddenEdgeIds = graph
        .getAllEdgesData()
        .map((edge) => edge.id)
        .filter((id) => graph.getItemVisible(id) === true);
      this.hiddenNodeIds = graph
        .getAllNodesData()
        .map((node) => node.id)
        .filter((id) => graph.getItemVisible(id) === true);

      const hiddenIds = [...this.hiddenNodeIds];
      const sectionNum = Math.ceil(hiddenIds.length / tileBehaviorSize);
      const sections = Array.from({ length: sectionNum }, (v, i) =>
        hiddenIds.slice(
          i * tileBehaviorSize,
          i * tileBehaviorSize + tileBehaviorSize,
        ),
      );
      const update = () => {
        if (!sections.length && this.tileRequestId) {
          cancelAnimationFrame(this.tileRequestId);
          this.tileRequestId = undefined;
          return;
        }
        const section = sections.shift();
        graph.startHistoryBatch();
        graph.hideItem(section, false, true);
        graph.stopHistoryBatch();
        this.tileRequestId = requestAnimationFrame(update);
      };
      this.tileRequestId = requestAnimationFrame(update);
    }
  }

  private endZoom() {
    const { graph, hiddenEdgeIds = [], hiddenNodeIds } = this;
    const { tileBehavior: graphBehaviorOptimize, tileBehaviorSize = 1000 } =
      graph.getSpecification().optimize || {};
    const optimize =
      this.options.enableOptimize !== undefined
        ? this.options.enableOptimize
        : graphBehaviorOptimize;
    const shouldOptimze = isNumber(optimize)
      ? graph.getAllNodesData().length > optimize
      : optimize;
    this.zooming = false;
    if (shouldOptimze) {
      if (this.tileRequestId) {
        cancelAnimationFrame(this.tileRequestId);
        this.tileRequestId = undefined;
      }
      if (hiddenNodeIds) {
        const hiddenIds = [...hiddenNodeIds, ...hiddenEdgeIds];
        const sectionNum = Math.ceil(hiddenIds.length / tileBehaviorSize);
        const sections = Array.from({ length: sectionNum }, (v, i) =>
          hiddenIds.slice(
            i * tileBehaviorSize,
            i * tileBehaviorSize + tileBehaviorSize,
          ),
        );
        const update = () => {
          if (!sections.length && this.tileRequestId) {
            cancelAnimationFrame(this.tileRequestId);
            this.tileRequestId = undefined;
            return;
          }
          graph.executeWithNoStack(() => {
            graph.showItem(sections.shift(), false);
          });
          this.tileRequestId = requestAnimationFrame(update);
        };
        this.tileRequestId = requestAnimationFrame(update);
      }
    }
    this.hiddenEdgeIds = [];
    this.hiddenNodeIds = [];
  }

  public onWheel(event) {
    const { graph, keydown } = this;
    const { deltaY, client, itemId } = event;
    const {
      eventName,
      sensitivity,
      secondaryKey,
      triggerOnItems,
      minZoom,
      maxZoom,
      shouldBegin,
      fixSelectedItems,
    } = this.options;

    // TODO: CANVAS
    const isOnItem = itemId && itemId !== 'CANVAS';
    if (
      (secondaryKey && !keydown) ||
      (isOnItem && !triggerOnItems) ||
      !shouldBegin(event)
    ) {
      this.endZoom();
      return;
    }

    // begin zooming
    if (!this.zooming) {
      this.hideShapes();
      this.zooming = true;
    }
    let zoomRatio = 1;
    if (deltaY < 0) zoomRatio = (100 + sensitivity) / 100;
    if (deltaY > 0) zoomRatio = 100 / (100 + sensitivity);
    const zoomTo = zoomRatio * graph.getZoom();
    if (minZoom && zoomTo < minZoom) return;
    if (maxZoom && zoomTo > maxZoom) return;

    // fix items when zooming
    if (fixSelectedItems) {
      const { fixAll, fixLabel, fixKeyShape, shapeIds } = fixSelectedItems;
      if (fixAll || fixLabel || fixKeyShape || !isEmpty(shapeIds)) {
        const zoom = graph.getZoom();
        if (zoom < 1) {
          const fixNodeIds = graph.findIdByState('node', 'selected');
          const fixEdgeIds = graph.findIdByState('edge', 'selected');

          each(fixNodeIds.concat(fixEdgeIds), (fixId) => {
            graph.balanceItemShape(fixId, true, fixSelectedItems.shapeIds);
          });
        }
      }
    }

    // TODO: the zoom center is wrong?
    graph.zoom(zoomRatio, { x: client.x, y: client.y });

    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => {
      this.endZoom();
    }, 300);

    // Emit event.
    if (eventName) {
      graph.emit(eventName, { zoom: { ratio: zoomRatio } });
    }
  }

  public onKeydown(event) {
    const { key } = event;
    const {
      secondaryKey,
      trigger,
      speedUpKey,
      eventName,
      sensitivity,
      shouldBegin,
    } = this.options;
    if (secondaryKey && secondaryKey === key.toLowerCase()) {
      this.keydown = true;
    }
    if (speedUpKey && speedUpKey === key.toLowerCase()) {
      this.speedupKeydown = true;
    }
    if (trigger === 'upDownKeys') {
      if (secondaryKey && !this.keydown) return;
      if (!shouldBegin(event)) return;
      const { graph, speedupKeydown } = this;
      const speed = speedupKeydown ? 20 : 1;
      let zoomRatio = 1;
      switch (key) {
        case 'ArrowUp':
          // Zoom in.
          zoomRatio = (100 + sensitivity * speed) / 100;
          break;
        case 'ArrowDown':
          // Zoom out.
          zoomRatio = 100 / (100 + sensitivity * speed);
          break;
      }
      if (zoomRatio !== 1) {
        graph.zoom(zoomRatio);
        if (eventName) {
          graph.emit(eventName, { zoom: { ratio: zoomRatio } });
        }
      }
    }
  }

  public onKeyup(event) {
    const { key } = event;
    const { secondaryKey, speedUpKey } = this.options;
    if (secondaryKey && secondaryKey === key.toLowerCase()) {
      this.keydown = false;
    }
    if (speedUpKey && speedUpKey === key.toLowerCase()) {
      this.speedupKeydown = false;
    }
  }
}
