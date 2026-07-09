import { Container, Graphics } from 'pixi.js';

export interface SpriteFactory {
  toad(): Container;
  toadGhost(): Container;
  tadpole(): Container;
  lilypad(): Container;
  ripple(): Container;
  firefly(): Container;
}

function rectangle(
  width: number,
  height: number,
  color: number,
  alpha = 1,
): Container {
  return new Graphics()
    .rect(-width / 2, -height / 2, width, height)
    .fill({ color, alpha });
}

export const placeholderSprites: SpriteFactory = {
  toad: () => rectangle(12, 12, 0x5dcb6a),
  toadGhost: () => rectangle(12, 12, 0x5dcb6a, 0.35),
  tadpole: () => rectangle(6, 6, 0x5dcb6a),
  lilypad: () =>
    new Graphics()
      .roundRect(-12, -3, 24, 6, 3)
      .fill({ color: 0x5dcb6a, alpha: 0.5 }),
  ripple: () => rectangle(24, 2, 0x24393d),
  firefly: () => rectangle(4, 4, 0xf2b24c),
};
