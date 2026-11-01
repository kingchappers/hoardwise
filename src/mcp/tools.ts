import { categoryDetailTool } from './tools/categoryDetail';
import { chartDataTool } from './tools/chartData';
import { displayGuidanceTool } from './tools/displayGuidance';
import { listCategoriesTool } from './tools/listCategories';
import { logIncomeTool, logSpendTool } from './tools/logMoney';
import { monthReviewTool } from './tools/monthReview';
import { potsOverviewTool } from './tools/potsOverview';
import { deleteStyleTool, listStylesTool, saveStyleTool } from './tools/styles';
import type { McpTool } from './types';

export const MCP_TOOLS: McpTool[] = [monthReviewTool, categoryDetailTool, potsOverviewTool, chartDataTool, displayGuidanceTool, listStylesTool, saveStyleTool, deleteStyleTool, listCategoriesTool, logSpendTool, logIncomeTool];
