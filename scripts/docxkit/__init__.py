# -*- coding: utf-8 -*-
"""docxkit: a dependency-free OOXML (.docx) writer with LaTeX -> OMML support.

Only needs lxml (and Pillow for image sizing).  Created because python-docx cannot
always be installed offline, and because native Word equation objects are required
for faithful technical translation.
"""
from .builder import Docx
from .texomml import latex_to_omml, latex_to_omml_para

__all__ = ['Docx', 'latex_to_omml', 'latex_to_omml_para']
