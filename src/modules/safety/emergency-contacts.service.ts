import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { apiBadRequest, apiConflict, apiNotFound } from "../../common/exceptions/api.exception";
import { User } from "../users/schemas/user.schema";
import type { CreateEmergencyContactDto, UpdateEmergencyContactDto } from "./dto/emergency-contact.dto";
import { EmergencyContact } from "./schemas/emergency-contact.schema";
import type { EmergencyContactDocument } from "./schemas/emergency-contact.schema";

export interface EmergencyContactView {
  id: string;
  name: string;
  phone: string;
  relationship?: string;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const isDuplicateKey = (error: unknown, index?: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: number }).code === 11000 &&
  (index === undefined || String((error as { message?: string }).message).includes(index));

const notFound = () => apiNotFound("Emergency contact not found", "EMERGENCY_CONTACT_NOT_FOUND");

/**
 * The user's emergency contacts. Every query is scoped by the caller's user
 * id, so another user's contact is simply "not found". Whenever the user
 * has contacts, exactly one is primary.
 */
@Injectable()
export class EmergencyContactsService {
  private readonly maxContacts: number;

  constructor(
    @InjectModel(EmergencyContact.name) private readonly contactModel: Model<EmergencyContact>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    config: ConfigService,
  ) {
    this.maxContacts = config.getOrThrow<number>("emergencyContactsMax");
  }

  async list(userId: string): Promise<EmergencyContactView[]> {
    const contacts = await this.contactModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ isPrimary: -1, createdAt: 1 })
      .exec();
    return contacts.map((contact) => this.toView(contact));
  }

  async create(userId: string, dto: CreateEmergencyContactDto): Promise<EmergencyContactView> {
    const owner = new Types.ObjectId(userId);
    await this.assertNotSelf(owner, dto.phone);
    const count = await this.contactModel.countDocuments({ userId: owner }).exec();
    if (count >= this.maxContacts)
      throw apiConflict(`You can save up to ${this.maxContacts} emergency contacts`, "EMERGENCY_CONTACT_LIMIT");

    const makePrimary = count === 0 || dto.isPrimary === true;
    if (makePrimary) await this.demoteAll(owner);
    try {
      const contact = await this.contactModel.create({
        userId: owner,
        name: dto.name,
        phone: dto.phone,
        relationship: dto.relationship,
        isPrimary: makePrimary,
      });
      return this.toView(contact);
    } catch (error) {
      if (isDuplicateKey(error, "phone"))
        throw apiConflict("This number is already one of your emergency contacts", "EMERGENCY_CONTACT_DUPLICATE");
      throw error;
    }
  }

  async update(userId: string, id: string, dto: UpdateEmergencyContactDto): Promise<EmergencyContactView> {
    const owner = new Types.ObjectId(userId);
    const contact = await this.contactModel.findOne({ _id: new Types.ObjectId(id), userId: owner }).exec();
    if (!contact) throw notFound();
    if (dto.isPrimary === false && contact.isPrimary)
      throw apiBadRequest("Choose another contact as primary instead", "VALIDATION_FAILED");
    if (dto.phone !== undefined) await this.assertNotSelf(owner, dto.phone);

    if (dto.name !== undefined) contact.name = dto.name;
    if (dto.phone !== undefined) contact.phone = dto.phone;
    if (dto.relationship !== undefined) contact.relationship = dto.relationship || undefined;
    try {
      await contact.save();
    } catch (error) {
      if (isDuplicateKey(error, "phone"))
        throw apiConflict("This number is already one of your emergency contacts", "EMERGENCY_CONTACT_DUPLICATE");
      throw error;
    }
    if (dto.isPrimary === true && !contact.isPrimary) await this.setPrimary(owner, contact._id);
    return this.toView((await this.contactModel.findById(contact._id).exec()) ?? contact);
  }

  async remove(userId: string, id: string): Promise<void> {
    const owner = new Types.ObjectId(userId);
    const removed = await this.contactModel.findOneAndDelete({ _id: new Types.ObjectId(id), userId: owner }).exec();
    if (!removed) throw notFound();
    if (removed.isPrimary) {
      // Promote the longest-standing remaining contact.
      const next = await this.contactModel.findOne({ userId: owner }).sort({ createdAt: 1 }).exec();
      if (next) await this.setPrimary(owner, next._id);
    }
  }

  /** Frozen onto an SOS incident so the safety team can call them. */
  async snapshot(userId: Types.ObjectId): Promise<Array<Pick<EmergencyContactView, "name" | "phone" | "relationship" | "isPrimary">>> {
    const contacts = await this.contactModel.find({ userId }).sort({ isPrimary: -1, createdAt: 1 }).lean().exec();
    return contacts.map((contact) => ({
      name: contact.name,
      phone: contact.phone,
      relationship: contact.relationship,
      isPrimary: contact.isPrimary,
    }));
  }

  private async setPrimary(owner: Types.ObjectId, contactId: Types.ObjectId): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.demoteAll(owner, contactId);
      try {
        await this.contactModel.updateOne({ _id: contactId, userId: owner }, { $set: { isPrimary: true } }).exec();
        return;
      } catch (error) {
        // A concurrent "make primary" won the partial unique index; retry.
        if (!isDuplicateKey(error)) throw error;
      }
    }
    throw apiConflict("Could not update the primary contact, please retry", "VALIDATION_FAILED");
  }

  private async demoteAll(owner: Types.ObjectId, except?: Types.ObjectId): Promise<void> {
    await this.contactModel
      .updateMany({ userId: owner, isPrimary: true, ...(except ? { _id: { $ne: except } } : {}) }, { $set: { isPrimary: false } })
      .exec();
  }

  private async assertNotSelf(owner: Types.ObjectId, phone: string): Promise<void> {
    const user = await this.userModel.findById(owner).select("phone").lean().exec();
    if (user?.phone === phone)
      throw apiBadRequest("Your own number cannot be an emergency contact", "EMERGENCY_CONTACT_SELF");
  }

  private toView(contact: EmergencyContactDocument): EmergencyContactView {
    return {
      id: contact._id.toString(),
      name: contact.name,
      phone: contact.phone,
      relationship: contact.relationship,
      isPrimary: contact.isPrimary,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    };
  }
}
