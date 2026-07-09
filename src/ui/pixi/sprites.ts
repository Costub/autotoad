import { Container, Graphics } from 'pixi.js';

export interface SpriteFactory {
  toad(): Container;
  toadGhost(): Container;
  tadpole(): Container;
  lilypad(): Container;
  ripple(): Container;
  firefly(): Container;
}

function makeToad(alpha = 1): Container {
  const root = new Container();
  const glow = new Graphics()
    .circle(0, 3, 16)
    .fill({ color: 0x5dcb6a, alpha: 0.12 * alpha });
  const shadow = new Graphics()
    .ellipse(0, 9, 13, 4)
    .fill({ color: 0x061013, alpha: 0.35 * alpha });
  const backLegs = new Graphics()
    .ellipse(-9, 6, 7, 4)
    .ellipse(9, 6, 7, 4)
    .fill({ color: 0x2f8f54, alpha })
    .stroke({ width: 1, color: 0x163923, alpha: 0.65 * alpha });
  const body = new Graphics()
    .ellipse(0, 3, 11, 9)
    .fill({ color: 0x5dcb6a, alpha })
    .stroke({ width: 1.5, color: 0x163923, alpha });
  const belly = new Graphics()
    .ellipse(0, 7, 6, 4)
    .fill({ color: 0xbdf0a5, alpha: 0.7 * alpha });
  const head = new Graphics()
    .roundRect(-9, -8, 18, 13, 7)
    .fill({ color: 0x68d776, alpha })
    .stroke({ width: 1.5, color: 0x163923, alpha });
  const eyes = new Graphics()
    .circle(-5, -8, 3.5)
    .circle(5, -8, 3.5)
    .fill({ color: 0xe8f1ee, alpha })
    .circle(-4.3, -7.6, 1.25)
    .circle(5.7, -7.6, 1.25)
    .fill({ color: 0x0e1b1e, alpha })
    .circle(-3.9, -8.1, 0.45)
    .circle(6.1, -8.1, 0.45)
    .fill({ color: 0xffffff, alpha });
  const mouth = new Graphics()
    .moveTo(-5, -1)
    .quadraticCurveTo(0, 2.5, 5, -1)
    .stroke({ width: 1.2, color: 0x163923, alpha: 0.75 * alpha });
  root.addChild(glow, shadow, backLegs, body, belly, head, eyes, mouth);
  return root;
}

function makeTadpole(): Container {
  const root = new Container();
  const tail = new Graphics()
    .moveTo(-4, 0)
    .quadraticCurveTo(-12, -5, -18, -1)
    .quadraticCurveTo(-11, 5, -4, 0)
    .fill({ color: 0x8be08a, alpha: 0.55 });
  const body = new Graphics()
    .ellipse(1, 0, 6, 4)
    .fill({ color: 0x5dcb6a, alpha: 0.95 })
    .stroke({ width: 1, color: 0x163923, alpha: 0.7 });
  const eye = new Graphics()
    .circle(4, -1.4, 0.9)
    .fill({ color: 0x0e1b1e, alpha: 0.8 });
  root.addChild(tail, body, eye);
  return root;
}

function makeLilypad(): Container {
  const root = new Container();
  const glow = new Graphics()
    .ellipse(0, 1, 18, 6)
    .fill({ color: 0x5dcb6a, alpha: 0.09 });
  const pad = new Graphics()
    .ellipse(0, 0, 15, 6.5)
    .fill({ color: 0x5dcb6a, alpha: 0.5 })
    .stroke({ width: 1, color: 0x9ce887, alpha: 0.25 })
    .moveTo(0, 0)
    .poly([0, 0, 13, -4, 8, 1])
    .fill({ color: 0x0e1b1e, alpha: 0.46 });
  const vein = new Graphics()
    .moveTo(-9, 0)
    .quadraticCurveTo(-2, -2, 8, 1)
    .stroke({ width: 1, color: 0xbdf0a5, alpha: 0.22 });
  root.addChild(glow, pad, vein);
  return root;
}

function makeRipple(): Container {
  return new Graphics()
    .moveTo(-12, 0)
    .quadraticCurveTo(-6, -2.5, 0, 0)
    .quadraticCurveTo(6, 2.5, 12, 0)
    .stroke({ width: 1.5, color: 0x24393d, alpha: 0.72 });
}

function makeFirefly(): Container {
  const root = new Container();
  const glow = new Graphics()
    .circle(0, 0, 8)
    .fill({ color: 0xf2b24c, alpha: 0.12 });
  const core = new Graphics()
    .circle(0, 0, 2.4)
    .fill({ color: 0xf2b24c, alpha: 0.95 })
    .stroke({ width: 1, color: 0xffe3a0, alpha: 0.45 });
  root.addChild(glow, core);
  return root;
}

export const placeholderSprites: SpriteFactory = {
  toad: () => makeToad(),
  toadGhost: () => makeToad(0.35),
  tadpole: () => makeTadpole(),
  lilypad: () => makeLilypad(),
  ripple: () => makeRipple(),
  firefly: () => makeFirefly(),
};
