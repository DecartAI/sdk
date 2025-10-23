import { z } from "zod";

export const modelStateSchema = z.object({
	prompt: z
		.object({
			text: z.string().min(1),
			enhance: z.boolean().optional().default(true),
		})
		.optional(),
	mirror: z.boolean().optional().default(false),
});
export type ModelState = z.infer<typeof modelStateSchema>;
