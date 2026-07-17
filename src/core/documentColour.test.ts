import { describe, expect, it } from 'vitest';
import { Document } from './Document';
import { aciToRgb } from '../io/DxfAci';

describe('layer colour by index', () => {
  it('draws a new object in its layer colour, as BYLAYER', () => {
    const doc = new Document();
    doc.layers.push('parts');
    doc.setLayerAci('parts', 1); // red
    doc.currentLayer = 'parts';
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(line.aci).toBe(256); // BYLAYER: "whatever my layer says"
    expect(line.color).toBe(0xff0000);
  });

  it('moves every BYLAYER object when its layer is recoloured', () => {
    const doc = new Document();
    doc.layers.push('parts');
    doc.currentLayer = 'parts';
    const a = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    const b = doc.createLine({ x: 0, y: 0 }, { x: 2, y: 0 });
    doc.addEntity(a);
    doc.addEntity(b);

    doc.setLayerAci('parts', 3); // green

    // The whole point of BYLAYER: the objects follow, without being touched one
    // by one — which is what the old copy-the-RGB model could not do.
    expect(a.color).toBe(0x00ff00);
    expect(b.color).toBe(0x00ff00);
  });

  it('leaves an overridden object alone when its layer changes', () => {
    const doc = new Document();
    doc.layers.push('parts');
    doc.currentLayer = 'parts';
    const own = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    const byLayer = doc.createLine({ x: 0, y: 0 }, { x: 2, y: 0 });
    doc.addEntity(own);
    doc.addEntity(byLayer);
    doc.setObjectsAci([own], [], 5); // this one is blue, no matter the layer

    doc.setLayerAci('parts', 1); // red

    expect(own.color).toBe(0x0000ff); // kept its override
    expect(byLayer.color).toBe(0xff0000); // followed the layer
  });

  it('repaints an object moved to another layer', () => {
    const doc = new Document();
    doc.layers.push('red', 'green');
    doc.setLayerAci('red', 1);
    doc.setLayerAci('green', 3);
    doc.currentLayer = 'red';
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.addEntity(line);
    expect(line.color).toBe(0xff0000);

    line.layer = 'green';
    doc.recolour();

    expect(line.color).toBe(0x00ff00);
  });

  it('keeps layer 0 white', () => {
    const doc = new Document();
    expect(doc.layerAci['0']).toBe(7);
    expect(doc.layerColorFor('0')).toBe(aciToRgb(7));
  });
});
