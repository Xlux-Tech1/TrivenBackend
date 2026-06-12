import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import Lead from '../lead/lead.model.js';
import User from '../user/user.model.js';
import * as leadService from '../lead/lead.service.js';

/**
 * Handle incoming webhooks from Interakt
 */
const handleWebhook = catchAsync(async (req, res) => {
  const payload = req.body;
  
  // DEBUGGING: Log EVERYTHING to database as a lead
  try {
    const rawLeadData = {
      name: `RAW WEBHOOK`,
      phone: `0000000000`,
      source: 'social_media',
      problem: JSON.stringify(payload).substring(0, 500),
      status: 'new'
    };
    await leadService.createLead(rawLeadData, null, 'admin');
  } catch(e) {}

  console.log(`[Interakt Webhook] Received:`, JSON.stringify(payload, null, 2));

  if (!payload || (!payload.entityType && !payload.type)) {
    return res.status(httpStatus.BAD_REQUEST).json(new ApiResponse(httpStatus.BAD_REQUEST, null, 'Invalid payload'));
  }

  try {
    const isMessage = payload.entityType === 'USER_MESSAGE' || payload.type === 'message_received';
    
    if (isMessage) {
      let phone, messageText, customerName, targetDepartment = 'migraine';
      
      if (payload.type === 'message_received' && payload.data) {
        phone = payload.data.customer?.phone_number || payload.data.customer?.phone;
        customerName = payload.data.customer?.traits?.name || `WhatsApp Lead (${phone})`;
        
        // Try to extract text. If not found, stringify the message object so we can see what's inside
        const msgObj = payload.data.message;
        let extractedText = "";
        
        if (typeof msgObj?.message === 'string') {
          extractedText = msgObj.message;
        } else if (msgObj?.message?.text) {
          extractedText = msgObj.message.text;
        } else if (msgObj?.text) {
          extractedText = msgObj.text;
        }

        // Check if there's a Facebook Ad referral
        let referralText = "";
        if (msgObj?.referral?.headline) {
          referralText = `\n[Clicked Ad: ${msgObj.referral.headline}]`;
        }

        messageText = extractedText ? (extractedText + referralText) : (msgObj ? JSON.stringify(msgObj) : "New message received");
        // Extract business phone number to route to the correct department
        let businessPhone = payload.data?.customer?.channel_phone_number || "";
        
        // Determine department based on business phone number
        const fallbackMigraine = "7309523829,917309523829,916376776399,6376776399";
        const migraineNumbers = (process.env.INTERAKT_MIGRAINE_NUMBERS || fallbackMigraine).split(",");
        const haircareNumbers = (process.env.INTERAKT_HAIRCARE_NUMBERS || "").split(",");
        
        targetDepartment = null; // Unassigned by default
        
        if (businessPhone && migraineNumbers.some(num => num.trim() !== "" && businessPhone.includes(num.trim()))) {
            targetDepartment = 'migraine';
        } else if (businessPhone && haircareNumbers.some(num => num.trim() !== "" && businessPhone.includes(num.trim()))) {
            targetDepartment = 'haircare';
        }
        
      } else {
        phone = payload.userPhoneNumber;
        customerName = `WhatsApp Lead (${phone})`;
        messageText = payload.message?.text || payload.entity?.text || payload.entity?.suggestionResponse?.postBack?.data || "New message received";
      }

      console.log(`User ${customerName} (${phone}) sent message: ${messageText} to department ${targetDepartment}`);
      
      // Save this as a note to the corresponding Lead using the phone number
      if (phone && messageText) {
        // Interakt sends phone numbers with + country code, e.g., +9193218...
        if (phone.startsWith('+91')) phone = phone.substring(3);
        else if (phone.startsWith('+')) phone = phone.substring(1);

        let lead = await Lead.findOne({ phone: { $regex: phone.slice(-10) + '$' } });
        const defaultAdmin = await User.findOne({ role: 'admin', isDeleted: false }).select('_id').lean();
        
        if (!lead) {
          // Auto-create a lead if it doesn't exist
          console.log(`[Interakt Webhook] Auto-creating new lead for phone ${phone}`);
          const newLeadData = {
            name: customerName,
            phone: phone,
            source: 'social_media',
            problem: `[Interakt Message] ${messageText}`,
            status: 'new'
          };
          
          if (targetDepartment) {
              newLeadData.department = targetDepartment;
          }
          
          lead = await leadService.createLead(newLeadData, defaultAdmin ? defaultAdmin._id : null, 'admin');
        } else {
            // If lead already exists, just add note
            // If we now have a real name, optionally update the lead's name if it was generic
            if (customerName && customerName !== `WhatsApp Lead (${phone})` && lead.name.startsWith('WhatsApp Lead')) {
               lead.name = customerName;
            }
            lead.notes.push({ text: `[Interakt Message] ${messageText}`, createdBy: defaultAdmin ? defaultAdmin._id : null });
            await lead.save();
        }
      }
    } else {
      console.log(`[Interakt Webhook] Received unhandled event: ${payload.entityType || payload.type}`);
    }
  } catch (error) {
    console.error(`[Interakt Webhook Error]`, error);
  }

  // Always return 200 OK to acknowledge receipt of the webhook to Interakt
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, null, 'Webhook received successfully'));
});

export default {
  handleWebhook,
  testWebhook: catchAsync(async (req, res) => {
    let lead = await Lead.findOne({ phone: "8888888888" });
    const defaultAdmin = await User.findOne({ role: 'admin', isDeleted: false }).select('_id').lean();
    if (!lead) {
      const newLeadData = {
        name: `WhatsApp Lead (8888888888)`,
        phone: "8888888888",
        source: 'social_media',
        problem: `[Interakt Message] TEST`,
        status: 'new'
      };
      lead = await leadService.createLead(newLeadData, defaultAdmin ? defaultAdmin._id : null, 'admin');
      res.status(200).json({ success: true, message: "Lead CREATED", lead });
    } else {
      res.status(200).json({ success: true, message: "Lead ALREADY EXISTS", lead });
    }
  }),
  latestLeads: catchAsync(async (req, res) => {
    const leads = await Lead.find({ source: 'social_media' }).sort({ createdAt: -1 }).limit(10).lean();
    res.status(200).json({ success: true, leads });
  })
};
