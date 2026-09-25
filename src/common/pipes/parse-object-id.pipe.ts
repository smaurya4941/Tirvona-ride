import { Injectable } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import { isValidObjectId } from "mongoose";
import { apiBadRequest } from "../exceptions/api.exception";

/** Rejects malformed ids with a clean 400 before they reach a query. */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== "string" || !/^[0-9a-f]{24}$/i.test(value) || !isValidObjectId(value))
      throw apiBadRequest("Invalid id", "VALIDATION_FAILED");
    return value;
  }
}
