import { categoryDetailTool } from './tools/categoryDetail';
import { chartDataTool } from './tools/chartData';
import { displayGuidanceTool } from './tools/displayGuidance';
import { monthReviewTool } from './tools/monthReview';
import { potsOverviewTool } from './tools/potsOverview';
import type { McpTool } from './types';

export const MCP_TOOLS: McpTool[] = [monthReviewTool, categoryDetailTool, potsOverviewTool, chartDataTool, displayGuidanceTool];
