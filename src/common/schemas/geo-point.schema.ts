import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

/**
 * GeoJSON Point sub-document. No defaults on purpose: a half-built point
 * (type without coordinates) is rejected by a 2dsphere index, so the whole
 * sub-document must be absent until a real position is known.
 */
@Schema({ _id: false })
export class GeoPoint {
  @Prop({ required: true, enum: ["Point"] })
  type!: "Point";

  /** [longitude, latitude] — GeoJSON order, not lat/lng. */
  @Prop({
    required: true,
    type: [Number],
    validate: {
      validator: (value: number[]) =>
        value.length === 2 &&
        value[0] >= -180 &&
        value[0] <= 180 &&
        value[1] >= -90 &&
        value[1] <= 90,
      message: "coordinates must be [longitude, latitude]",
    },
  })
  coordinates!: [number, number];
}

export const GeoPointSchema = SchemaFactory.createForClass(GeoPoint);
